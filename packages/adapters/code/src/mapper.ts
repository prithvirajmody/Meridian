/**
 * The `CodeMapper` seam: "parse one file and map it to its {@link RawModule}
 * skeleton". Two implementations share one interface so the mapping walk is
 * identical whether it runs in a worker or on the calling thread:
 *
 * - {@link createWorkerMapper} runs parse+map **in a worker** ({@link
 *   ParseWorkerHost.map}) — the production/CLI wiring, honoring the "grammars
 *   only load in workers" gate.
 * - {@link createInProcessMapper} runs them on the calling thread via the shim
 *   — used by conformance and unit tests (7B already loads grammars on the main
 *   thread in Node tests), and as a dependency-light option.
 *
 * Both produce byte-identical `RawModule`s (a parity test asserts it): the walk
 * is pure and the shim isomorphic, so "worker vs not" is a *when*, never a
 * *what* (ADR-0027).
 */
import { buildBody } from './detail/body.js';
import type { RawBody } from './detail/types.js';
import type { CodeLanguage } from './languages.js';
import { mapModuleTree } from './map/map-module.js';
import type { RawModule } from './map/raw.js';
import { parseSource } from './parse.js';
import { createParserRuntime, type ParserRuntime, type ParserRuntimeOptions } from './shim.js';
import type { ParseWorkerHost } from './worker/host.js';

/** A request to map one file. */
export interface MapModuleRequest {
  readonly language: CodeLanguage;
  /** Repository-relative POSIX path — the ADR-0028 `source` coordinate. */
  readonly source: string;
  /** Display label (basename). */
  readonly label: string;
  readonly text: string;
}

/** A request to materialize one function/method body (7F, ADR-0027): the file
 * text plus the declaration's byte span (the cold node's provenance span). */
export interface ResolveBodyRequest {
  readonly language: CodeLanguage;
  /** Repository-relative POSIX path — the ADR-0028 `source` coordinate. */
  readonly source: string;
  readonly text: string;
  /** `[startIndex, endIndex]` byte span of the function/method declaration. */
  readonly declSpan: readonly [number, number];
}

export interface CodeMapper {
  mapModule(req: MapModuleRequest): Promise<RawModule>;
  /** Parse `req.text` and build the {@link RawBody} of the declaration at
   * `req.declSpan`; `undefined` if no resolvable body is found (7F). Honors an
   * optional cancellation signal (ADR-0027 abandoned drill-in). */
  resolveBody(req: ResolveBodyRequest, opts?: { readonly signal?: AbortSignal }): Promise<RawBody | undefined>;
  dispose(): Promise<void>;
}

/** In-process mapper (parse + map on the calling thread). Test/CLI-light path. */
export function createInProcessMapper(runtimeOptions: ParserRuntimeOptions): CodeMapper {
  let runtime: Promise<ParserRuntime> | undefined;
  const getRuntime = (): Promise<ParserRuntime> => {
    if (runtime === undefined) {
      runtime = createParserRuntime(runtimeOptions);
      runtime.catch(() => (runtime = undefined));
    }
    return runtime;
  };
  return {
    async mapModule(req) {
      const parser = await (await getRuntime()).parser(req.language);
      try {
        const { tree } = parseSource(parser, req.language, req.text);
        try {
          return mapModuleTree(tree, req.language, { source: req.source, label: req.label });
        } finally {
          tree.delete();
        }
      } finally {
        parser.delete();
      }
    },
    async resolveBody(req) {
      const parser = await (await getRuntime()).parser(req.language);
      try {
        const { tree } = parseSource(parser, req.language, req.text);
        try {
          return buildBody(tree, req.language, req.declSpan);
        } finally {
          tree.delete();
        }
      } finally {
        parser.delete();
      }
    },
    async dispose() {
      /* the runtime holds no OS handles; nothing to release */
    },
  };
}

/** Worker-backed mapper (production/CLI): grammars load only in the worker. */
export function createWorkerMapper(host: ParseWorkerHost): CodeMapper {
  return {
    async mapModule(req) {
      const { module } = await host.map(req);
      return module;
    },
    async resolveBody(req, opts) {
      const { body } = await host.resolveBody(req, opts);
      return body;
    },
    async dispose() {
      await host.dispose();
    },
  };
}
