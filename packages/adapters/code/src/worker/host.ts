/**
 * `ParseWorkerHost`: the main-thread owner of one long-lived parse worker,
 * reusing 4C's worker-infrastructure pattern (ADR-0017): Comlink RPC for
 * `parse`, a dedicated control port for preemptive cancels, an injected
 * {@link WorkerFactory} so this module imports no `node:*` and no DOM (the
 * concrete worker comes from the environment — Node factory in `test/`,
 * browser factory with the Studio wiring, exactly like layout's host), and
 * crash recovery by respawn.
 *
 * Differences from the layout host, deliberate for parsing:
 * - **Concurrent requests are allowed** (files are independent; layout's
 *   one-slot supersede rule is a *layout* policy, not a protocol rule).
 *   Comlink serializes the RPC calls; each carries its own `requestId`.
 * - **No fallback provider.** Parsing has no analog of the total `grid`
 *   layout; a crash rejects in-flight requests with a located error (honest
 *   failure) and the next request gets a fresh worker.
 *
 * The seam types ({@link WorkerFactory}, {@link WorkerHandle}) mirror
 * layout's shapes but are declared here: the dependency law (§20) forbids an
 * adapter from importing `@meridian/layout`, so the *pattern* is reused, not
 * the package.
 */
import * as Comlink from 'comlink';
import type { CodeLanguage } from '../languages.js';
import type { ParseOutcome } from '../parse.js';
import {
  abortError,
  type CancelMessage,
  type CancelledMessage,
  type ParseResponse,
  type ParseWorkerApi,
} from './worker-api.js';

/** How a worker died. */
export interface CrashInfo {
  readonly kind: 'error' | 'exit';
  readonly error?: unknown;
  readonly code?: number;
}

/** The host's side of the dedicated control port. */
export interface HostControlChannel {
  postMessage(msg: CancelMessage): void;
  onMessage(cb: (msg: CancelledMessage) => void): void;
  close(): void;
}

/** One spawned worker, wired by the {@link WorkerFactory}. */
export interface WorkerHandle {
  readonly rpc: Comlink.Endpoint;
  readonly control: HostControlChannel;
  onCrash(cb: (info: CrashInfo) => void): void;
  terminate(): void | Promise<void>;
}

/** Spawns a fresh worker (browser or Node); called at startup and respawn. */
export type WorkerFactory = () => WorkerHandle;

export interface ParseWorkerHostOptions {
  readonly factory: WorkerFactory;
}

export interface ParseHostStats {
  readonly dispatched: number;
  readonly completed: number;
  readonly cancelled: number;
  readonly cancelAcks: number;
  readonly failed: number;
  readonly crashes: number;
  readonly respawns: number;
}

export interface ParseHostOptions {
  /** External cancellation; abort posts a preemptive control-port cancel. */
  readonly signal?: AbortSignal;
}

interface InFlight {
  readonly requestId: number;
  settle(outcome: ParseResponse): void;
  fail(error: unknown): void;
  settled: boolean;
  abortListener?: () => void;
  readonly signal?: AbortSignal;
}

export class ParseWorkerHost {
  private readonly factory: WorkerFactory;
  private handle?: WorkerHandle;
  private proxy?: Comlink.Remote<ParseWorkerApi>;
  private control?: HostControlChannel;
  private readonly inFlight = new Map<number, InFlight>();
  private requestSeq = 0;
  private disposed = false;

  private s = {
    dispatched: 0,
    completed: 0,
    cancelled: 0,
    cancelAcks: 0,
    failed: 0,
    crashes: 0,
    respawns: 0,
  };

  constructor(opts: ParseWorkerHostOptions) {
    this.factory = opts.factory;
  }

  /** Pre-load a grammar in the worker (spawning it if needed). */
  async warm(language: CodeLanguage): Promise<void> {
    if (this.disposed) throw new Error('ParseWorkerHost: disposed');
    this.ensureWorker();
    await this.proxy!.warm(language);
  }

  /**
   * Parse `text` as `language` in the worker. Rejects with `AbortError` if
   * `signal` fires first, or with a located error if the worker crashes.
   */
  async parse(language: CodeLanguage, text: string, opts: ParseHostOptions = {}): Promise<ParseOutcome> {
    if (this.disposed) throw new Error('ParseWorkerHost: disposed');
    if (opts.signal?.aborted) throw abortError();
    this.s.dispatched++;
    this.ensureWorker();

    const requestId = ++this.requestSeq;
    let settle!: (r: ParseResponse) => void;
    let fail!: (e: unknown) => void;
    const promise = new Promise<ParseResponse>((res, rej) => {
      settle = res;
      fail = rej;
    });
    const inflight: InFlight = {
      requestId,
      settle,
      fail,
      settled: false,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    };
    this.inFlight.set(requestId, inflight);

    if (opts.signal !== undefined) {
      const onAbort = (): void => this.cancel(inflight);
      inflight.abortListener = onAbort;
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    this.proxy!.parse({ requestId, language, text }).then(
      (response) => {
        if (inflight.settled) return; // cancelled or crash-handled: drop late result
        this.s.completed++;
        this.settle(inflight, response);
      },
      (error: unknown) => {
        if (inflight.settled) return;
        if (isAbortError(error) || inflight.signal?.aborted) {
          this.fail(inflight, abortError());
          return;
        }
        this.s.failed++;
        this.fail(inflight, error);
      },
    );

    return promise;
  }

  stats(): ParseHostStats {
    return { ...this.s };
  }

  /** Tear down: reject anything in flight and terminate the worker. */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const inflight of [...this.inFlight.values()]) {
      this.fail(inflight, new Error('ParseWorkerHost: disposed with request in flight'));
    }
    await this.teardownWorker();
  }

  // -------------------------------------------------------------- internals

  private ensureWorker(): void {
    if (this.handle !== undefined) return;
    const handle = this.factory();
    this.handle = handle;
    this.proxy = Comlink.wrap<ParseWorkerApi>(handle.rpc);
    this.control = handle.control;
    handle.control.onMessage((msg) => {
      if (msg.type === 'cancelled') this.s.cancelAcks++;
    });
    handle.onCrash((info) => this.handleCrash(info));
  }

  private handleCrash(info: CrashInfo): void {
    this.s.crashes++;
    const detail =
      info.kind === 'exit'
        ? `worker exited with code ${info.code ?? 'unknown'}`
        : `worker error: ${info.error instanceof Error ? info.error.message : String(info.error)}`;
    for (const inflight of [...this.inFlight.values()]) {
      this.fail(inflight, new Error(`adapter-code: parse worker crashed mid-request (${detail})`));
    }
    void this.teardownWorker();
    // Lazy respawn: the next warm/parse spawns a fresh worker.
    if (!this.disposed) this.s.respawns++;
  }

  private async teardownWorker(): Promise<void> {
    const handle = this.handle;
    const control = this.control;
    this.handle = undefined;
    this.proxy = undefined;
    this.control = undefined;
    try {
      control?.close();
    } catch {
      /* best-effort */
    }
    try {
      await handle?.terminate();
    } catch {
      /* best-effort */
    }
  }

  private cancel(inflight: InFlight): void {
    if (inflight.settled) return;
    this.s.cancelled++;
    this.control?.postMessage({ type: 'cancel', requestId: inflight.requestId });
    this.fail(inflight, abortError());
  }

  private settle(inflight: InFlight, response: ParseResponse): void {
    if (inflight.settled) return;
    inflight.settled = true;
    this.cleanup(inflight);
    inflight.settle(response);
  }

  private fail(inflight: InFlight, error: unknown): void {
    if (inflight.settled) return;
    inflight.settled = true;
    this.cleanup(inflight);
    inflight.fail(error);
  }

  private cleanup(inflight: InFlight): void {
    this.inFlight.delete(inflight.requestId);
    if (inflight.abortListener !== undefined && inflight.signal !== undefined) {
      inflight.signal.removeEventListener('abort', inflight.abortListener);
    }
  }
}

/** True for a standard `AbortError` (name-based, cross-realm safe). */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}
