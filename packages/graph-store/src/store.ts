/**
 * The GraphStore (ROADMAP Phase 1 §5): the only mutable authority over graph
 * state. Immutable structurally-shared snapshots (ADR-0006), op-based deltas
 * as the one write path (ADR-0005), monotonic version stamps (ADR-0007),
 * batched async subscriptions (ADR-0008), incrementally-maintained indices,
 * and the fluent query API.
 */
import {
  MeridianError,
  validate,
  type GraphId,
  type GraphSpace,
  type NodeId,
  type SemanticGraph,
} from '@meridian/graph-core';
import { Engine } from './engine.js';
import {
  buildEngineIndices,
  buildQueryIndices,
  EngineIndexView,
  updateQueryIndices,
  type EngineIndices,
  type QueryIndices,
} from './indices.js';
import type { StoreIssue } from './issues.js';
import type { GraphDelta, GraphDeltaInput, GraphOp, OpOrigin } from './ops.js';
import { OpViolation } from './payload.js';
import { GraphQueryImpl, type GraphQuery } from './query.js';
import { GraphTransactionImpl, type GraphTransaction } from './transaction.js';
import { initialVersion, successorVersion, versionsEqual, type VersionStamp } from './version.js';

/**
 * Internal-only access to a store's persistence queue. Keeping this in a
 * WeakMap lets the Phase-11 staging orchestrator apply real backpressure
 * without adding a persistence method to the public GraphStore contract.
 */
const backendSettlers = new WeakMap<GraphStore, () => Promise<void>>();

/** One committed transaction, as delivered to subscribers (ADR-0008). */
export interface ChangeSet {
  readonly fromVersion: VersionStamp;
  readonly toVersion: VersionStamp;
  readonly origin: OpOrigin;
  readonly ops: readonly GraphOp[];
  readonly touched: {
    readonly graphs: ReadonlySet<GraphId>;
    readonly nodes: ReadonlySet<NodeId>;
  };
}

export type ChangeListener = (change: ChangeSet) => void;
export type Unsubscribe = () => void;

export type ApplyResult =
  | { readonly ok: true; readonly delta: GraphDelta; readonly changes: ChangeSet }
  | { readonly ok: false; readonly errors: readonly StoreIssue[] };

/**
 * The injected persistence seam (ADR-0038, §12.2). After every committed
 * non-volatile transaction the store notifies the backend — `appendOps`
 * (durable op log) then `persist` (element materialization) — asynchronously,
 * in commit order, off the write path's critical section. Backend failures
 * are contained (routed to `onBackendError`) and never poison the store; the
 * backend never mutates the store — hydration (ADR-0039) flows back through
 * ordinary deltas.
 */
export interface StorageBackend {
  loadGraph(id: GraphId): Promise<SemanticGraph | null>;
  /** Called post-commit, async, in commit order. */
  persist(change: ChangeSet): Promise<void>;
  /** Durable op-log append (the P12 substrate). Called before `persist`. */
  appendOps(delta: GraphDelta): Promise<void>;
  /** Advisory, fire-and-forget (ADR-0039 eviction; backends may ignore). */
  evictHint(ids: readonly GraphId[]): void;
}

export interface GraphStore {
  /** Immutable, structurally shared, O(1) (ADR-0006). */
  snapshot(): GraphSpace;
  version(): VersionStamp;
  /** Atomic: the whole delta applies and yields a valid space, or nothing does. */
  apply(delta: GraphDeltaInput): ApplyResult;
  /** Record ops through a transaction object; committed atomically on return. */
  transact(fn: (tx: GraphTransaction) => void, origin: OpOrigin): ApplyResult;
  subscribe(listener: ChangeListener): Unsubscribe;
  query(): GraphQuery;
}

export interface CreateStoreOptions {
  /**
   * Where contained listener exceptions go (ADR-0008). The store cannot log
   * (no I/O in the semantic core); hosts install a real reporter.
   */
  readonly onListenerError?: (error: unknown) => void;
  /** Persistence backend (ADR-0038). Absent = in-memory session, as ever. */
  readonly backend?: StorageBackend;
  /**
   * Seed for the version counter — how durable stamps survive a reload
   * (ADR-0007 assigned this to P11; ADR-0038 delivers it). Absent = v0.
   */
  readonly initialVersion?: VersionStamp;
  /**
   * Where contained backend failures go (same containment doctrine as
   * listeners). The session stays valid; durability is the enhancement.
   */
  readonly onBackendError?: (error: unknown) => void;
}

class Store implements GraphStore {
  private current: GraphSpace;
  private stamp: VersionStamp;
  private readonly engineIndices: EngineIndices;
  private readonly queryIndices: QueryIndices;
  private readonly listeners = new Set<ChangeListener>();
  private readonly pending: Array<{ change: ChangeSet; targets: ChangeListener[] }> = [];
  private flushScheduled = false;
  private dispatching = false;
  private readonly onListenerError: (error: unknown) => void;
  private readonly backend: StorageBackend | undefined;
  private readonly onBackendError: (error: unknown) => void;
  /** FIFO chain so the backend sees commits in order (ADR-0038). */
  private backendQueue: Promise<void> = Promise.resolve();

  constructor(space: GraphSpace, opts: CreateStoreOptions) {
    this.current = space;
    this.stamp = opts.initialVersion ?? initialVersion();
    this.engineIndices = buildEngineIndices(space);
    this.queryIndices = buildQueryIndices(space);
    this.onListenerError = opts.onListenerError ?? (() => {});
    this.backend = opts.backend;
    this.onBackendError = opts.onBackendError ?? (() => {});
    backendSettlers.set(this, () => this.backendQueue);
  }

  snapshot(): GraphSpace {
    return this.current;
  }

  version(): VersionStamp {
    return this.stamp;
  }

  apply(delta: GraphDeltaInput): ApplyResult {
    this.guardReentrancy('apply');
    const envelope = this.checkEnvelope(delta);
    if (envelope) return { ok: false, errors: [envelope] };

    const engine = new Engine(this.current, new EngineIndexView(this.engineIndices));
    for (let i = 0; i < delta.ops.length; i++) {
      try {
        engine.applyOp(delta.ops[i]!);
      } catch (e) {
        if (e instanceof OpViolation) return { ok: false, errors: [e.toIssue(i)] };
        throw e;
      }
    }
    return { ok: true, ...this.commit(engine, delta.origin) };
  }

  transact(fn: (tx: GraphTransaction) => void, origin: OpOrigin): ApplyResult {
    this.guardReentrancy('transact');
    const envelope = this.checkEnvelope({ origin, ops: [] }, true);
    if (envelope) return { ok: false, errors: [envelope] };

    const engine = new Engine(this.current, new EngineIndexView(this.engineIndices));
    const tx = new GraphTransactionImpl(engine);
    try {
      fn(tx);
    } catch (e) {
      if (e instanceof OpViolation) return { ok: false, errors: [e.toIssue(engine.ops.length)] };
      return {
        ok: false,
        errors: [
          {
            code: 'transaction-aborted',
            message: `transaction aborted: ${e instanceof Error ? e.message : String(e)}`,
          },
        ],
      };
    } finally {
      tx.close();
    }
    if (engine.ops.length === 0) {
      return {
        ok: false,
        errors: [{ code: 'empty-delta', message: 'transaction recorded no ops — nothing to commit' }],
      };
    }
    return { ok: true, ...this.commit(engine, origin) };
  }

  subscribe(listener: ChangeListener): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  query(): GraphQuery {
    return new GraphQueryImpl(
      () => this.current,
      this.engineIndices,
      this.queryIndices,
    );
  }

  // ------------------------------------------------------------- internals

  private guardReentrancy(what: string): void {
    if (this.dispatching) {
      throw new MeridianError(
        'reentrant-mutation',
        `${what} called from inside a change listener — handlers never mutate re-entrantly; enqueue instead (ADR-0008, §1.4)`,
      );
    }
  }

  private checkEnvelope(delta: GraphDeltaInput, skipEmpty = false): StoreIssue | undefined {
    if (typeof delta.origin?.actor !== 'string' || delta.origin.actor.length === 0) {
      return {
        code: 'invalid-delta',
        message: 'delta.origin.actor must be a non-empty string — history without issuers is forbidden (§3.1)',
      };
    }
    if (delta.baseVersion !== undefined && !versionsEqual(delta.baseVersion, this.stamp)) {
      return {
        code: 'stale-delta',
        message: `delta baseVersion v${delta.baseVersion.counter}@${delta.baseVersion.site} does not match store version v${this.stamp.counter}@${this.stamp.site} — rebase/merge is a Phase 12 concern; v1 refuses (ADR-0007)`,
      };
    }
    if (!skipEmpty && delta.ops.length === 0) {
      return { code: 'empty-delta', message: 'delta has no ops — nothing to commit' };
    }
    return undefined;
  }

  private commit(engine: Engine, origin: OpOrigin): { delta: GraphDelta; changes: ChangeSet } {
    const fromVersion = this.stamp;
    const toVersion = successorVersion(fromVersion);
    this.current = engine.finish();
    this.stamp = toVersion;
    engine.view.fold();
    updateQueryIndices(this.queryIndices, engine.ops);

    const delta: GraphDelta = { baseVersion: fromVersion, origin, ops: engine.ops };
    const changes: ChangeSet = {
      fromVersion,
      toVersion,
      origin,
      ops: engine.ops,
      touched: { graphs: engine.touchedGraphs, nodes: engine.touchedNodes },
    };
    // Capture the listener set at commit time (ADR-0008): later subscribers
    // never see this batch; unsubscribers still receive it (it is a fact).
    if (this.listeners.size > 0) {
      this.pending.push({ change: changes, targets: [...this.listeners] });
      if (!this.flushScheduled) {
        this.flushScheduled = true;
        queueMicrotask(() => this.flush());
      }
    }
    // Post-commit, async, FIFO: log first, then materialize (ADR-0038).
    // Volatile commits are cache movements, never durability (ADR-0039).
    // Failures are contained per commit so one error cannot stall the chain.
    if (this.backend && origin.volatile !== true) {
      const backend = this.backend;
      this.backendQueue = this.backendQueue
        .then(() => backend.appendOps(delta))
        .then(() => backend.persist(changes))
        .catch((e) => {
          try {
            this.onBackendError(e);
          } catch {
            // a throwing error hook must not poison later commits
          }
        });
    }
    return { delta, changes };
  }

  private flush(): void {
    this.flushScheduled = false;
    this.dispatching = true;
    try {
      while (this.pending.length > 0) {
        const batch = this.pending.shift()!;
        for (const listener of batch.targets) {
          try {
            listener(batch.change);
          } catch (e) {
            this.onListenerError(e);
          }
        }
      }
    } finally {
      this.dispatching = false;
    }
  }
}

/** @internal Await every backend notification queued by this store so far. */
export function settleStoreBackend(store: GraphStore): Promise<void> {
  const settle = backendSettlers.get(store);
  if (settle === undefined) {
    return Promise.reject(new MeridianError('invalid-store', 'cannot settle a store not created by createStore'));
  }
  return settle();
}

/**
 * Create a store over a valid space. Throws `MeridianError('invalid-space')`
 * on invalid input — feeding a store garbage is a programming error, not a
 * data outcome (the data gate is `decode`). Root order is normalized to the
 * canonical (sorted) form so state equality is structural (ADR-0006).
 */
export function createStore(space: GraphSpace, opts: CreateStoreOptions = {}): GraphStore {
  if (opts.initialVersion !== undefined) {
    const v = opts.initialVersion;
    if (!Number.isInteger(v.counter) || v.counter < 0 || typeof v.site !== 'string' || v.site.length === 0) {
      throw new MeridianError(
        'invalid-version',
        `createStore: initialVersion must be { counter: non-negative integer, site: non-empty string }, got ${JSON.stringify(v)}`,
      );
    }
  }
  const result = validate(space);
  if (!result.ok) {
    const first = result.errors[0]!;
    throw new MeridianError(
      'invalid-space',
      `createStore: space is invalid (${result.errors.length} errors) — first: [${first.code}] ${first.message}`,
    );
  }
  const normalized: GraphSpace = {
    graphs: space.graphs,
    roots: [...space.roots].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  };
  return new Store(normalized, opts);
}

/**
 * Pure state transform (ROADMAP Phase 1 §6): apply a delta to a space
 * without a store — no versions, no events, no maintained indices (they are
 * built transiently, O(space)). The store path is the cheap one; this is the
 * utility for tests, tools, and P3 proposal previews. The input space must be
 * valid (programming error otherwise); root order is canonicalized like
 * `createStore`.
 */
export function applyDelta(
  space: GraphSpace,
  delta: GraphDeltaInput,
): { ok: true; space: GraphSpace; ops: readonly GraphOp[] } | { ok: false; errors: readonly StoreIssue[] } {
  const valid = validate(space);
  if (!valid.ok) {
    const first = valid.errors[0]!;
    throw new MeridianError(
      'invalid-space',
      `applyDelta: space is invalid (${valid.errors.length} errors) — first: [${first.code}] ${first.message}`,
    );
  }
  if (typeof delta.origin?.actor !== 'string' || delta.origin.actor.length === 0) {
    return {
      ok: false,
      errors: [{ code: 'invalid-delta', message: 'delta.origin.actor must be a non-empty string' }],
    };
  }
  if (delta.ops.length === 0) {
    return { ok: false, errors: [{ code: 'empty-delta', message: 'delta has no ops — nothing to apply' }] };
  }
  const normalized: GraphSpace = {
    graphs: space.graphs,
    roots: [...space.roots].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  };
  const engine = new Engine(normalized, new EngineIndexView(buildEngineIndices(normalized)));
  for (let i = 0; i < delta.ops.length; i++) {
    try {
      engine.applyOp(delta.ops[i]!);
    } catch (e) {
      if (e instanceof OpViolation) return { ok: false, errors: [e.toIssue(i)] };
      throw e;
    }
  }
  return { ok: true, space: engine.finish(), ops: engine.ops };
}
