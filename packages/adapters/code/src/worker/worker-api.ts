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
import type { CodeLanguage } from '../languages.js';
import { mapModuleTree } from '../map/map-module.js';
import type { RawModule } from '../map/raw.js';
import { parseSource, type ParseOutcome } from '../parse.js';
import { createParserRuntime, type ParserRuntime, type ParserRuntimeOptions } from '../shim.js';

/** Host→worker control message (over the dedicated control port). */
export interface CancelMessage {
  readonly type: 'cancel';
  readonly requestId: number;
}

/** Worker→host control acknowledgement (observability). */
export interface CancelledMessage {
  readonly type: 'cancelled';
  readonly requestId: number;
}

/** The worker's view of the dedicated control port (adapted by the entry shim). */
export interface WorkerControlChannel {
  postMessage(msg: CancelledMessage): void;
  onMessage(cb: (msg: CancelMessage) => void): void;
}

export interface ParseRequest {
  readonly requestId: number;
  readonly language: CodeLanguage;
  readonly text: string;
}

/** A {@link ParseOutcome} plus worker-side timing (budget observability). */
export interface ParseResponse extends ParseOutcome {
  readonly requestId: number;
  readonly parseTimeMs: number;
}

/** A map request: like {@link ParseRequest} plus the coordinate/label the
 * skeleton needs (7C). The **mapping walk runs here, where the tree lives**
 * (ADR-0017); only the graph-shaped {@link RawModule} crosses the boundary. */
export interface MapRequest {
  readonly requestId: number;
  readonly language: CodeLanguage;
  /** Repository-relative POSIX path — the ADR-0028 `source` coordinate. */
  readonly source: string;
  /** Display label (basename). */
  readonly label: string;
  readonly text: string;
}

export interface MapResponse {
  readonly requestId: number;
  readonly module: RawModule;
  readonly mapTimeMs: number;
}

/** The Comlink-exposed worker surface. */
export interface ParseWorkerApi {
  /** Pre-load a grammar (idempotent) so first-parse latency excludes it. */
  warm(language: CodeLanguage): Promise<void>;
  parse(req: ParseRequest): Promise<ParseResponse>;
  /** Parse **and** map one file to its {@link RawModule} skeleton (7C). */
  map(req: MapRequest): Promise<MapResponse>;
}

/** Portable `AbortError` (`DOMException` where available). */
export function abortError(): Error {
  try {
    return new DOMException('Aborted', 'AbortError');
  } catch {
    const e = new Error('Aborted');
    e.name = 'AbortError';
    return e;
  }
}

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
  };
}
