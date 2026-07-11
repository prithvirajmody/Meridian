/**
 * `LayoutWorkerHost` (ADR-0017): the main-thread owner of one long-lived worker
 * and a Comlink proxy to the exposed worker object. It builds typed-array
 * requests, transfers them zero-copy, re-hydrates responses **lazily** (O(1) on
 * the hot path — the 4ms guarantee), and implements the three protocol
 * behaviours 4C must demonstrate:
 *
 * - **New request aborts stale one.** At most one request is in flight per
 *   slot; a new `compute` fires the stale request's preemptive cancel over the
 *   control port and rejects its promise with `AbortError` *before* dispatching.
 * - **Preemptive cancellation.** An external `AbortSignal` posts a cancel over
 *   the dedicated control port (not the serialized Comlink port), so a
 *   cooperative provider abandons promptly.
 * - **Crash recovery → grid.** A provider that *throws in the worker* is re-run
 *   with the deterministic `grid` provider **in the (still-alive) worker**
 *   (degraded). A worker that *dies* is torn down and the in-flight request is
 *   settled with a **main-thread `grid`** layout (the single sanctioned > 4ms
 *   waiver, ADR-0017 Q1 ruling), then a fresh worker is respawned; a crash
 *   budget trips a circuit breaker that pins the slot to main-thread grid.
 *
 * Isomorphic: the host imports no `node:*` and no DOM — the concrete worker
 * (a browser `Worker` or a Node `worker_threads.Worker`) is supplied by an
 * injected {@link WorkerFactory}, so the same host runs under vitest (Node) and
 * in Studio (browser). This is the substrate P5 picking and P7 parsing reuse.
 */
import type { InducedEdge } from '@meridian/view-model';
import * as Comlink from 'comlink';
import { gridProvider } from '../grid.js';
import type { LayoutInput, LayoutProvider, LayoutResult } from '../types.js';
import type { LayoutCache, LayoutCacheKey } from './cache.js';
import {
  buildIndexTable,
  decodeResponseLazy,
  encodeRequest,
  requestTransfer,
  type IndexTable,
  type WireResponse,
} from './protocol.js';
import { abortError, type CancelMessage, type CancelledMessage, type LayoutWorkerApi } from './worker-api.js';

// ------------------------------------------------------------- worker handle

/** How a worker died (ADR-0017 crash recovery). */
export interface CrashInfo {
  readonly kind: 'error' | 'exit';
  readonly error?: unknown;
  readonly code?: number;
}

/** The host's side of the dedicated control port (adapted from a raw
 * `MessagePort` by the factory). */
export interface HostControlChannel {
  postMessage(msg: CancelMessage): void;
  onMessage(cb: (msg: CancelledMessage) => void): void;
  close(): void;
}

/** One spawned worker, wired by the {@link WorkerFactory}. `rpc` is the Comlink
 * endpoint; `control` the separate cancel port; `onCrash` fires on
 * `error`/`exit`/`messageerror`; `terminate` tears it down. */
export interface WorkerHandle {
  readonly rpc: Comlink.Endpoint;
  readonly control: HostControlChannel;
  onCrash(cb: (info: CrashInfo) => void): void;
  terminate(): void | Promise<void>;
}

/** Spawns a fresh worker (browser or Node). Called once at startup and again
 * on each respawn after a crash. */
export type WorkerFactory = () => WorkerHandle;

// --------------------------------------------------------------- host types

/** Crash budget for the circuit breaker (ADR-0017). */
export interface CrashBudget {
  readonly maxCrashes: number;
  readonly windowMs: number;
}

export const DEFAULT_CRASH_BUDGET: CrashBudget = { maxCrashes: 5, windowMs: 60_000 };

export interface LayoutWorkerHostOptions {
  readonly factory: WorkerFactory;
  /** Deterministic emergency/fallback provider. Default `grid` (total on any
   * finite input, so it cannot itself fail — ADR-0017). */
  readonly fallbackProvider?: LayoutProvider;
  readonly crashBudget?: CrashBudget;
  /** Optional shared {@link LayoutCache}; a hit short-circuits the worker. */
  readonly cache?: LayoutCache;
  /** Injectable clock (tests); defaults to `Date.now`. */
  readonly now?: () => number;
}

/** Where a returned layout came from (for diagnosis / the degraded flag). */
export type LayoutSource = 'worker' | 'worker-fallback' | 'main-fallback' | 'cache';

/** The host's result: the layout plus provenance of *how* it was produced. */
export interface LayoutHostResult {
  readonly layout: LayoutResult;
  /** True iff a provider failed and `grid` was substituted (ADR-0017). */
  readonly degraded: boolean;
  /** The provider that actually produced `layout`. */
  readonly provider: string;
  /** The provider originally requested (differs from `provider` when degraded). */
  readonly requested: string;
  readonly source: LayoutSource;
}

export interface LayoutComputeOptions {
  /** Warm-start / stability basis (ADR-0016), in the request's index space. */
  readonly prev?: LayoutResult;
  /** External cancellation; abort posts a preemptive control-port cancel. */
  readonly signal?: AbortSignal;
  /** Cache key; a hit returns the stored layout by reference (< 1ms). */
  readonly cacheKey?: LayoutCacheKey;
}

/** Cumulative host counters (ADR-0017 "surfaced in host stats"). */
export interface LayoutHostStats {
  readonly dispatched: number;
  readonly cacheHits: number;
  readonly workerCompleted: number;
  readonly providerThrows: number;
  readonly crashes: number;
  readonly respawns: number;
  readonly mainFallbacks: number;
  readonly cancelled: number;
  readonly cancelAcks: number;
  readonly breakerTripped: boolean;
  /** Max synchronous main-thread ms spent encoding+dispatching a request. */
  readonly maxDispatchMs: number;
  /** Max synchronous main-thread ms spent handling a worker response. */
  readonly maxHandleMs: number;
}

interface InFlight {
  readonly requestId: number;
  readonly providerId: string;
  readonly input: LayoutInput;
  readonly edges: readonly InducedEdge[];
  readonly table: IndexTable;
  readonly prev?: LayoutResult;
  readonly signal?: AbortSignal;
  settle: (r: LayoutHostResult) => void;
  fail: (e: unknown) => void;
  settled: boolean;
  abortListener?: () => void;
}

const clock: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();

/** True for a standard `AbortError` (name-based, cross-realm safe). */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

export class LayoutWorkerHost {
  private readonly factory: WorkerFactory;
  private readonly fallback: LayoutProvider;
  private readonly crashBudget: CrashBudget;
  private readonly cache?: LayoutCache;
  private readonly now: () => number;

  private handle?: WorkerHandle;
  private proxy?: Comlink.Remote<LayoutWorkerApi>;
  private control?: HostControlChannel;

  private current?: InFlight;
  private requestSeq = 0;
  private breakerTripped = false;
  private readonly crashTimes: number[] = [];
  private disposed = false;

  // Reuse the index table across deltas on the same cut (ADR-0017: the O(N)
  // index-table build is amortized, not per-request).
  private tableCacheMembers?: readonly unknown[];
  private tableCache?: IndexTable;

  private s = {
    dispatched: 0,
    cacheHits: 0,
    workerCompleted: 0,
    providerThrows: 0,
    crashes: 0,
    respawns: 0,
    mainFallbacks: 0,
    cancelled: 0,
    cancelAcks: 0,
    maxDispatchMs: 0,
    maxHandleMs: 0,
  };

  constructor(opts: LayoutWorkerHostOptions) {
    this.factory = opts.factory;
    this.fallback = opts.fallbackProvider ?? gridProvider;
    this.crashBudget = opts.crashBudget ?? DEFAULT_CRASH_BUDGET;
    this.cache = opts.cache;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Lay out `input` with `providerId`, off the main thread. Resolves to a
   * {@link LayoutHostResult}; rejects with `AbortError` if the request is
   * superseded or its `signal` fires. Cache hit → immediate buffer-ref return.
   */
  async compute(
    providerId: string,
    input: LayoutInput,
    opts: LayoutComputeOptions = {},
  ): Promise<LayoutHostResult> {
    if (this.disposed) throw new Error('LayoutWorkerHost: disposed');
    this.s.dispatched++;

    if (opts.cacheKey !== undefined && this.cache !== undefined) {
      const hit = this.cache.get(opts.cacheKey);
      if (hit !== undefined) {
        this.s.cacheHits++;
        return { layout: hit, degraded: false, provider: providerId, requested: providerId, source: 'cache' };
      }
    }

    if (opts.signal?.aborted) throw abortError();

    // New request aborts the stale one (ADR-0017) — before dispatching.
    this.abortCurrent();

    // Circuit breaker: pinned to main-thread grid until reset.
    if (this.breakerTripped) {
      const r = await this.mainGrid(providerId, input, opts.prev);
      this.maybeCache(opts.cacheKey, r.layout);
      return r;
    }

    const table = this.indexTableFor(input.cut.members);
    const requestId = ++this.requestSeq;
    let settle!: (r: LayoutHostResult) => void;
    let fail!: (e: unknown) => void;
    const promise = new Promise<LayoutHostResult>((res, rej) => {
      settle = res;
      fail = rej;
    });
    const inflight: InFlight = {
      requestId,
      providerId,
      input,
      edges: input.edges,
      table,
      ...(opts.prev !== undefined ? { prev: opts.prev } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      settle,
      fail,
      settled: false,
    };
    this.current = inflight;

    if (opts.signal !== undefined) {
      const onAbort = (): void => this.abortViaSignal(inflight);
      inflight.abortListener = onAbort;
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    this.ensureWorker();
    this.dispatchToWorker(inflight, providerId, opts.prev);

    const result = await promise;
    this.maybeCache(opts.cacheKey, result.layout);
    return result;
  }

  /** Cumulative counters (ADR-0017). */
  stats(): LayoutHostStats {
    return { ...this.s, breakerTripped: this.breakerTripped };
  }

  /** Tear down: abort any in-flight request and terminate the worker. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.abortCurrent();
    await this.teardownWorker();
  }

  // ------------------------------------------------------------- internals

  private indexTableFor(members: readonly unknown[]): IndexTable {
    if (this.tableCacheMembers === members && this.tableCache !== undefined) return this.tableCache;
    const table = buildIndexTable(members as InFlight['table']['ids']);
    this.tableCacheMembers = members;
    this.tableCache = table;
    return table;
  }

  private ensureWorker(): void {
    if (this.handle !== undefined || this.breakerTripped) return;
    this.spawn();
  }

  private spawn(): void {
    const handle = this.factory();
    this.handle = handle;
    this.proxy = Comlink.wrap<LayoutWorkerApi>(handle.rpc);
    this.control = handle.control;
    handle.control.onMessage((msg) => {
      if (msg.type === 'cancelled') this.s.cancelAcks++;
    });
    handle.onCrash((info) => this.handleCrash(info));
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

  private dispatchToWorker(inflight: InFlight, providerId: string, prev?: LayoutResult, degradedFrom?: string): void {
    const proxy = this.proxy;
    if (proxy === undefined) {
      // Worker gone (crashed between abortCurrent and here): main-thread grid.
      this.settleWithMainGrid(inflight, degradedFrom ?? providerId);
      return;
    }
    const t0 = clock();
    const req = encodeRequest(inflight.requestId, providerId, inflight.input, inflight.table, prev);
    const transfer = requestTransfer(req);
    const call = proxy.compute(Comlink.transfer(req, transfer) as typeof req);
    const dt = clock() - t0;
    if (dt > this.s.maxDispatchMs) this.s.maxDispatchMs = dt;
    call.then(
      (res: WireResponse) => this.onWorkerResponse(inflight, res, providerId, degradedFrom),
      (err: unknown) => this.onWorkerError(inflight, err, providerId, prev, degradedFrom),
    );
  }

  private onWorkerResponse(inflight: InFlight, res: WireResponse, providerId: string, degradedFrom?: string): void {
    if (inflight.settled) return; // superseded/aborted/crashed → drop late result
    const t0 = clock();
    const layout = decodeResponseLazy(res, inflight.table, inflight.edges);
    const dt = clock() - t0;
    if (dt > this.s.maxHandleMs) this.s.maxHandleMs = dt;
    this.s.workerCompleted++;
    this.settle(inflight, {
      layout,
      degraded: degradedFrom !== undefined,
      provider: providerId,
      requested: degradedFrom ?? providerId,
      source: degradedFrom !== undefined ? 'worker-fallback' : 'worker',
    });
  }

  private onWorkerError(
    inflight: InFlight,
    err: unknown,
    providerId: string,
    prev: LayoutResult | undefined,
    degradedFrom?: string,
  ): void {
    if (inflight.settled) return; // aborted or crash-handled already
    if (isAbortError(err) || inflight.signal?.aborted) {
      this.fail(inflight, abortError());
      return;
    }
    // A provider threw in the worker (worker still alive). Re-run with grid in
    // the worker. If grid itself threw (should be impossible), go to main-grid.
    if (degradedFrom !== undefined || providerId === this.fallback.id) {
      this.settleWithMainGrid(inflight, degradedFrom ?? providerId);
      return;
    }
    this.s.providerThrows++;
    this.dispatchToWorker(inflight, this.fallback.id, prev, providerId);
  }

  private handleCrash(_info: CrashInfo): void {
    this.s.crashes++;
    this.crashTimes.push(this.now());
    const cur = this.current;
    // The dead worker cannot answer: settle the in-flight request with an
    // emergency MAIN-THREAD grid (the sanctioned > 4ms frame, ADR-0017 Q1).
    if (cur !== undefined && !cur.settled) {
      this.settleWithMainGrid(cur, cur.providerId);
    }
    void this.teardownWorker();
    if (this.crashesInWindow() >= this.crashBudget.maxCrashes) {
      this.breakerTripped = true; // pin to main-thread grid; do not respawn
      return;
    }
    if (!this.disposed) {
      this.spawn();
      this.s.respawns++;
    }
  }

  private crashesInWindow(): number {
    const cutoff = this.now() - this.crashBudget.windowMs;
    let count = 0;
    for (const t of this.crashTimes) if (t >= cutoff) count++;
    return count;
  }

  /** Run the emergency grid on the MAIN THREAD and settle `inflight`. */
  private settleWithMainGrid(inflight: InFlight, requested: string): void {
    this.s.mainFallbacks++;
    this.fallback.compute(inflight.input, inflight.prev).then(
      (layout) => {
        if (inflight.settled) return;
        this.settle(inflight, {
          layout,
          degraded: true,
          provider: this.fallback.id,
          requested,
          source: 'main-fallback',
        });
      },
      (e) => {
        if (!inflight.settled) this.fail(inflight, e);
      },
    );
  }

  /** Await a main-thread grid layout (breaker-tripped fast path). */
  private async mainGrid(requested: string, input: LayoutInput, prev?: LayoutResult): Promise<LayoutHostResult> {
    this.s.mainFallbacks++;
    const layout = await this.fallback.compute(input, prev);
    return { layout, degraded: true, provider: this.fallback.id, requested, source: 'main-fallback' };
  }

  private abortCurrent(): void {
    const cur = this.current;
    if (cur === undefined || cur.settled) return;
    this.s.cancelled++;
    this.control?.postMessage({ type: 'cancel', requestId: cur.requestId });
    this.fail(cur, abortError());
  }

  private abortViaSignal(inflight: InFlight): void {
    if (inflight.settled) return;
    this.s.cancelled++;
    this.control?.postMessage({ type: 'cancel', requestId: inflight.requestId });
    this.fail(inflight, abortError());
  }

  private settle(inflight: InFlight, result: LayoutHostResult): void {
    if (inflight.settled) return;
    inflight.settled = true;
    this.cleanup(inflight);
    inflight.settle(result);
  }

  private fail(inflight: InFlight, err: unknown): void {
    if (inflight.settled) return;
    inflight.settled = true;
    this.cleanup(inflight);
    inflight.fail(err);
  }

  private cleanup(inflight: InFlight): void {
    if (this.current === inflight) this.current = undefined;
    if (inflight.abortListener !== undefined && inflight.signal !== undefined) {
      inflight.signal.removeEventListener('abort', inflight.abortListener);
    }
  }

  private maybeCache(key: LayoutCacheKey | undefined, layout: LayoutResult): void {
    if (key !== undefined && this.cache !== undefined) this.cache.set(key, layout);
  }
}
