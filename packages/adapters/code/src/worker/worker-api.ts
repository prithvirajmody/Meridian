/**
 * The worker-side parse object. Runs **inside the worker** — the roadmap's
 * Phase 7 architecture gate is "grammars only loaded in workers", so this is
 * the only module that touches the shim in production wiring; the entry shims
 * (Node `worker_threads` / browser `new Worker`) adapt the environment.
 *
 * The two-channel shape reuses 4C's worker infrastructure pattern (ADR-0017):
 * - **RPC** (Comlink): `warm`/`parse`, the methods the host calls.
 * - **Control** (dedicated port, never the RPC port): `{type:'cancel',
 *   requestId}` host→worker, `{type:'cancelled'}` back. A tree-sitter parse of
 *   one file is a single synchronous call — not interruptible mid-parse — so
 *   cancellation is elk-style "run to return, then drop" (ADR-0017 Q2), plus
 *   the pre-cancel set for cancels that outrun their `parse` (the 4C fold-back).
 *
 * Isomorphic: no `node:*`, no DOM. Trees are summarized and deleted here; only
 * the serializable {@link ParseOutcome} crosses the boundary (7C's mapping will
 * also run worker-side, so whole trees never need to cross).
 */
import { buildBody } from '../detail/body.js';
import type { CodeLanguage } from '../languages.js';
import { mapModuleTree } from '../map/map-module.js';
import { parseSource } from '../parse.js';
import { createParserRuntime, type ParserRuntime, type ParserRuntimeOptions } from '../shim.js';
import {
  abortError,
  type MapRequest,
  type MapResponse,
  type ParseRequest,
  type ParseResponse,
  type ParseWorkerApi,
  type ResolveBodyRequest,
  type ResolveBodyResponse,
  type WorkerControlChannel,
} from './protocol.js';

export { abortError } from './protocol.js';
export type {
  CancelledMessage,
  CancelMessage,
  MapRequest,
  MapResponse,
  ParseRequest,
  ParseResponse,
  ParseWorkerApi,
  ResolveBodyRequest,
  ResolveBodyResponse,
  WorkerControlChannel,
} from './protocol.js';

const PRECANCEL_CAP = 4096;

/**
 * Construct the worker-side parse object. The runtime initializes lazily on
 * first use so a spawn is cheap and an init failure surfaces as a located
 * error on the first RPC rather than an unobservable worker death.
 */
export function createParseWorker(opts: {
  readonly runtime: ParserRuntimeOptions;
  readonly control: WorkerControlChannel;
}): ParseWorkerApi {
  let runtime: Promise<ParserRuntime> | undefined;
  const cancelled = new Set<number>();

  opts.control.onMessage((msg) => {
    if (msg.type !== 'cancel') return;
    if (cancelled.size >= PRECANCEL_CAP) cancelled.clear(); // bound memory
    cancelled.add(msg.requestId);
    opts.control.postMessage({ type: 'cancelled', requestId: msg.requestId });
  });

  const getRuntime = (): Promise<ParserRuntime> => {
    if (runtime === undefined) {
      runtime = createParserRuntime(opts.runtime);
      runtime.catch(() => (runtime = undefined)); // allow retry after failure
    }
    return runtime;
  };

  return {
    async warm(language: CodeLanguage): Promise<void> {
      await (await getRuntime()).language(language);
    },

    async parse(req: ParseRequest): Promise<ParseResponse> {
      try {
        if (cancelled.delete(req.requestId)) throw abortError();
        const parser = await (await getRuntime()).parser(req.language);
        const started = performance.now();
        try {
          const { tree, outcome } = parseSource(parser, req.language, req.text);
          const parseTimeMs = performance.now() - started;
          tree.delete();
          // Run-to-return-then-drop: a cancel that landed mid-parse still
          // surfaces as a standard AbortError instead of a stale result.
          if (cancelled.delete(req.requestId)) throw abortError();
          return { ...outcome, requestId: req.requestId, parseTimeMs };
        } finally {
          parser.delete();
        }
      } finally {
        cancelled.delete(req.requestId);
      }
    },

    async map(req: MapRequest): Promise<MapResponse> {
      try {
        if (cancelled.delete(req.requestId)) throw abortError();
        const parser = await (await getRuntime()).parser(req.language);
        const started = performance.now();
        try {
          const { tree } = parseSource(parser, req.language, req.text);
          try {
            const module = mapModuleTree(tree, req.language, { source: req.source, label: req.label });
            const mapTimeMs = performance.now() - started;
            if (cancelled.delete(req.requestId)) throw abortError();
            return { module, requestId: req.requestId, mapTimeMs };
          } finally {
            tree.delete();
          }
        } finally {
          parser.delete();
        }
      } finally {
        cancelled.delete(req.requestId);
      }
    },

    async resolveBody(req: ResolveBodyRequest): Promise<ResolveBodyResponse> {
      try {
        if (cancelled.delete(req.requestId)) throw abortError();
        const parser = await (await getRuntime()).parser(req.language);
        const started = performance.now();
        try {
          const { tree } = parseSource(parser, req.language, req.text);
          try {
            const body = buildBody(tree, req.language, req.declSpan);
            const resolveTimeMs = performance.now() - started;
            if (cancelled.delete(req.requestId)) throw abortError();
            return { body, requestId: req.requestId, resolveTimeMs };
          } finally {
            tree.delete();
          }
        } finally {
          parser.delete();
        }
      } finally {
        cancelled.delete(req.requestId);
      }
    },
  };
}
