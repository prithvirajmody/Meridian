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
import type { CodeLanguage } from './languages.js';
import { mapTypeScriptModule } from './map/typescript.js';
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

export interface CodeMapper {
  mapModule(req: MapModuleRequest): Promise<RawModule>;
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
      if (req.language !== 'typescript') {
        throw new Error(`adapter-code: mapping for "${req.language}" is not implemented in 7C (TypeScript only)`);
      }
      const parser = await (await getRuntime()).parser(req.language);
      try {
        const { tree } = parseSource(parser, req.language, req.text);
        try {
          return mapTypeScriptModule(tree, { source: req.source, label: req.label });
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
    async dispose() {
      await host.dispose();
    },
  };
}
