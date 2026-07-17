/**
 * Pure/injected-clock pieces of the Phase 11 ChangeSet → cut diff → layout
 * patch → render patch path. Studio owns orchestration; semantic/layout/render
 * packages remain independent and continue to expose full-value fallbacks.
 */
import type { LodResult } from '@meridian/abstraction';
import type { GraphId, NodeId } from '@meridian/graph-core';
import type { ChangeSet, GraphOp } from '@meridian/graph-store';
import type { LayoutResult, Rect } from '@meridian/view-model';

const byString = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export interface ChangeBatchSummary {
  readonly changes: readonly ChangeSet[];
  readonly changeCount: number;
  readonly opCount: number;
  readonly touchedGraphs: ReadonlySet<GraphId>;
  readonly touchedNodes: ReadonlySet<NodeId>;
  readonly structureChanged: boolean;
}

function structureChanging(op: GraphOp): boolean {
  return (
    op.t === 'graph:add' ||
    op.t === 'graph:remove' ||
    op.t === 'node:add' ||
    op.t === 'node:remove' ||
    op.t === 'node:detail'
  );
}

export function summarizeChanges(changes: readonly ChangeSet[]): ChangeBatchSummary {
  const touchedGraphs = new Set<GraphId>();
  const touchedNodes = new Set<NodeId>();
  let opCount = 0;
  let structureChanged = false;
  for (const change of changes) {
    opCount += change.ops.length;
    for (const id of change.touched.graphs) touchedGraphs.add(id);
    for (const id of change.touched.nodes) touchedNodes.add(id);
    if (!structureChanged && change.ops.some(structureChanging)) structureChanged = true;
  }
  return {
    changes,
    changeCount: changes.length,
    opCount,
    touchedGraphs,
    touchedNodes,
    structureChanged,
  };
}

export interface AffectedCutDiff {
  readonly added: readonly NodeId[];
  readonly removed: readonly NodeId[];
  readonly retained: readonly NodeId[];
  /** Retained visible members whose induced adjacency was recomputed. */
  readonly affected: readonly NodeId[];
}

export function diffAffectedCut(
  previous: LodResult,
  next: LodResult,
  recomputed: Iterable<NodeId> = [],
): AffectedCutDiff {
  const before = new Set(previous.cut.members);
  const after = new Set(next.cut.members);
  const added = next.cut.members.filter((id) => !before.has(id)).sort(byString);
  const removed = previous.cut.members.filter((id) => !after.has(id)).sort(byString);
  const retained = next.cut.members.filter((id) => before.has(id)).sort(byString);
  const retainedSet = new Set(retained);
  const affected = [...new Set(recomputed)].filter((id) => retainedSet.has(id)).sort(byString);
  return { added, removed, retained, affected };
}

function sameRect(left: Rect | undefined, right: Rect | undefined): boolean {
  return (
    left !== undefined && right !== undefined &&
    left.x === right.x && left.y === right.y &&
    left.width === right.width && left.height === right.height
  );
}

function sameRoute(
  left: readonly { readonly x: number; readonly y: number }[] | undefined,
  right: readonly { readonly x: number; readonly y: number }[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index]!.x !== right[index]!.x || left[index]!.y !== right[index]!.y) return false;
  }
  return true;
}

export interface LayoutResultPatch {
  readonly next: LayoutResult;
  readonly added: readonly NodeId[];
  readonly removed: readonly NodeId[];
  readonly changed: readonly NodeId[];
  readonly changedRoutes: readonly string[];
  readonly boundsChanged: boolean;
}

export function diffLayoutResults(previous: LayoutResult, next: LayoutResult): LayoutResultPatch {
  const ids = new Set<NodeId>([...previous.positions.keys(), ...next.positions.keys()]);
  const added: NodeId[] = [];
  const removed: NodeId[] = [];
  const changed: NodeId[] = [];
  for (const id of ids) {
    const before = previous.positions.get(id);
    const after = next.positions.get(id);
    if (before === undefined && after !== undefined) added.push(id);
    else if (before !== undefined && after === undefined) removed.push(id);
    else if (!sameRect(before, after)) changed.push(id);
  }

  const beforeRoutes = previous.edgeRoutes ?? new Map();
  const afterRoutes = next.edgeRoutes ?? new Map();
  const routeKeys = new Set([...beforeRoutes.keys(), ...afterRoutes.keys()]);
  const changedRoutes = [...routeKeys]
    .filter((key) => !sameRoute(beforeRoutes.get(key), afterRoutes.get(key)))
    .sort(byString);
  const boundsChanged = !sameRect(previous.bounds, next.bounds);
  return {
    next,
    added: added.sort(byString),
    removed: removed.sort(byString),
    changed: changed.sort(byString),
    changedRoutes,
    boundsChanged,
  };
}

export interface BatchCoalescerOptions<T> {
  readonly windowMs?: number;
  readonly maxPending?: number;
  readonly schedule?: (callback: () => void, delayMs: number) => unknown;
  readonly cancel?: (handle: unknown) => void;
  /** Collapse a full pending buffer while an async consumer is in flight.
   * Callers that cannot losslessly compact should omit it; enqueue then throws
   * at the hard limit instead of growing without bound. */
  readonly compact?: (pending: readonly T[]) => T;
  readonly onError?: (error: unknown) => void;
}

/** Bounded, order-preserving, single-flight coalescer. A synchronous 100-event
 * edit storm is one downstream batch. Promise-returning consumers are never
 * overlapped; while one is active, newer values collect into the next batch. */
export class BatchCoalescer<T> {
  private readonly windowMs: number;
  private readonly maxPending: number;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private readonly compact: ((pending: readonly T[]) => T) | undefined;
  private readonly onError: (error: unknown) => void;
  private pending: T[] = [];
  private handle: unknown;
  private inFlight = false;
  private disposed = false;

  constructor(
    private readonly consume: (batch: readonly T[]) => void | Promise<void>,
    options: BatchCoalescerOptions<T> = {},
  ) {
    this.windowMs = options.windowMs ?? 16;
    this.maxPending = options.maxPending ?? 1024;
    if (!Number.isFinite(this.windowMs) || this.windowMs < 0) {
      throw new RangeError('incremental coalescer windowMs must be finite and non-negative');
    }
    if (!Number.isSafeInteger(this.maxPending) || this.maxPending < 1) {
      throw new RangeError('incremental coalescer maxPending must be a positive safe integer');
    }
    this.schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.compact = options.compact;
    this.onError = options.onError ?? (() => undefined);
  }

  enqueue(value: T): void {
    if (this.disposed) throw new Error('incremental coalescer is disposed');
    if (this.inFlight && this.pending.length >= this.maxPending) {
      if (this.compact === undefined) {
        throw new RangeError('incremental coalescer pending limit reached while consumer is active');
      }
      this.pending = [this.compact(this.pending)];
    }
    this.pending.push(value);
    if (this.pending.length >= this.maxPending) {
      if (this.inFlight) {
        if (this.compact === undefined) {
          throw new RangeError('incremental coalescer pending limit reached while consumer is active');
        }
        this.pending = [this.compact(this.pending)];
      } else {
        this.flush();
      }
      return;
    }
    if (this.handle === undefined) {
      this.handle = this.schedule(() => {
        this.handle = undefined;
        this.flushBatch();
      }, this.windowMs);
    }
  }

  flush(): void {
    if (this.handle !== undefined) {
      this.cancel(this.handle);
      this.handle = undefined;
    }
    this.flushBatch();
  }

  get size(): number {
    return this.pending.length;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.handle !== undefined) this.cancel(this.handle);
    this.handle = undefined;
    this.pending = [];
  }

  private flushBatch(): void {
    if (this.inFlight || this.disposed) return;
    while (this.pending.length > 0 && !this.disposed) {
      const batch = this.pending;
      this.pending = [];
      this.inFlight = true;
      let result: void | Promise<void>;
      try {
        result = this.consume(batch);
      } catch (error) {
        this.inFlight = false;
        this.onError(error);
        continue;
      }
      if (result !== undefined && typeof result.then === 'function') {
        void Promise.resolve(result).then(
          () => this.consumerSettled(),
          (error: unknown) => {
            this.onError(error);
            this.consumerSettled();
          },
        );
        return;
      }
      this.inFlight = false;
    }
  }

  private consumerSettled(): void {
    this.inFlight = false;
    this.flushBatch();
  }
}
