/**
 * Graph-granular lazy hydration & eviction (ADR-0039; §4.7). The manager
 * orchestrates the cold ↔ live state machine *through the one write path*:
 * hydration and eviction are ordinary volatile deltas (`OpOrigin.volatile`,
 * ADR-0038 §3) — the version advances, subscriptions fire, caches
 * invalidate — but nothing enters the durable log, because the durable
 * tables already hold everything ("eviction writes nothing").
 *
 * Representation (ADR-0039 §2): a cold graph is a *shell* — present in the
 * space with its real meta and zero elements, still claimed by its parent
 * node, its own descendants absent entirely. The space is always a top slab
 * of the containment forest, so roots stay truthful and U1 holds.
 *
 * The `GraphStore` interface is untouched — §4.7's "read API makes state
 * visible" obligation is discharged here: `state()`, `summary()`,
 * `coldSet()` (the pure `LodRequest.cold` input), `stats()`.
 */
import {
  MeridianError,
  type GraphId,
  type GraphMeta,
} from '@meridian/graph-core';
import type { GraphOpInput } from './ops.js';
import type { ChangeSet, GraphStore, StorageBackend, Unsubscribe } from './store.js';
import { versionsEqual, type VersionStamp } from './version.js';

export type HydrationState = 'cold' | 'hydrating' | 'live' | 'evictable';

/** Identity + summary metadata for every durable graph (§4.7 "cold =
 * identity + summary metadata only") — supplied by the backend's manifest
 * (ADR-0038 `graphs.node_count/edge_count`), maintained here as the session
 * commits semantic changes. */
export interface GraphManifestEntry {
  readonly meta: GraphMeta;
  readonly nodeCount: number;
  readonly edgeCount: number;
}

export interface HydrationPolicy {
  /** Resident-element ceiling (nodes + edges across live graphs). */
  readonly maxResidentElements?: number;
  /** Eviction drains to this fraction of the ceiling (ADR-0039 §5). */
  readonly lowWaterRatio?: number;
  /** Actor stamped on volatile hydration/eviction deltas. */
  readonly actor?: string;
}

export interface HydrationStats {
  readonly residentElements: number;
  readonly liveGraphs: number;
  readonly coldGraphs: number;
  readonly hydrations: number;
  readonly evictions: number;
  /** True when the ceiling is exceeded and nothing more is evictable —
   * correctness over budget (the ADR-0014 precedence rule). */
  readonly overBudget: boolean;
}

export interface HydrationManagerOptions {
  readonly store: GraphStore;
  readonly backend: StorageBackend;
  readonly manifest: ReadonlyMap<GraphId, GraphManifestEntry>;
  readonly policy?: HydrationPolicy;
}

export const DEFAULT_MAX_RESIDENT_ELEMENTS = 200_000;
export const DEFAULT_LOW_WATER_RATIO = 0.85;
export const HYDRATION_ACTOR = 'meridian:hydration';

export class HydrationManager {
  private readonly store: GraphStore;
  private readonly backend: StorageBackend;
  private readonly manifest: Map<GraphId, GraphManifestEntry>;
  private readonly maxResident: number;
  private readonly lowWater: number;
  private readonly actor: string;

  private readonly live = new Set<GraphId>();
  private readonly inFlight = new Map<GraphId, Promise<void>>();
  private readonly pinned = new Set<GraphId>();
  /** Graphs touched by any non-volatile commit this session — the ADR-0039
   * undo-protection set: an inverse of a session delta always finds its
   * targets live. Only grows; bounded by session edits. */
  private readonly historyProtected = new Set<GraphId>();
  private readonly lastTouch = new Map<GraphId, number>();
  private touchClock = 0;
  private residentElements = 0;
  private hydrations = 0;
  private evictions = 0;
  /** Highest contiguous store version whose residency/history effects this
   * manager has accounted. Semantic commits advance it from `onChange`; our
   * own volatile commits may advance it synchronously because their effects
   * are applied at the call site. A gap conservatively disables eviction. */
  private lastObservedVersion: VersionStamp;
  private readonly unsubscribe: Unsubscribe;

  constructor(opts: HydrationManagerOptions) {
    this.store = opts.store;
    this.backend = opts.backend;
    this.manifest = new Map(opts.manifest);
    this.maxResident = opts.policy?.maxResidentElements ?? DEFAULT_MAX_RESIDENT_ELEMENTS;
    this.lowWater = Math.floor(this.maxResident * (opts.policy?.lowWaterRatio ?? DEFAULT_LOW_WATER_RATIO));
    this.actor = opts.policy?.actor ?? HYDRATION_ACTOR;
    this.lastObservedVersion = this.store.version();

    // Initial residency: a graph in the space is live iff it holds elements
    // or is durably empty (manifest counts 0 — nothing to hydrate). An empty
    // graph whose manifest says "has elements" is a cold shell.
    const space = this.store.snapshot();
    for (const [id, graph] of space.graphs) {
      const size = graph.nodes.size + graph.edges.size;
      const entry = this.manifest.get(id);
      if (size > 0 || entry === undefined || entry.nodeCount + entry.edgeCount === 0) {
        this.live.add(id);
        this.residentElements += size;
      }
    }

    this.unsubscribe = this.store.subscribe((change) => this.onChange(change));
  }

  // ---------------------------------------------------------------- reads

  state(id: GraphId): HydrationState {
    if (this.inFlight.has(id)) return 'hydrating';
    if (this.live.has(id)) return this.isEvictable(id) ? 'evictable' : 'live';
    return 'cold';
  }

  summary(id: GraphId): GraphManifestEntry | undefined {
    return this.manifest.get(id);
  }

  /** The pure cold input for `LodRequest.cold`: every durable graph that is
   * not live (shells and still-absent descendants alike). */
  coldSet(): ReadonlySet<GraphId> {
    const cold = new Set<GraphId>();
    for (const id of this.manifest.keys()) {
      if (!this.live.has(id)) cold.add(id);
    }
    return cold;
  }

  stats(): HydrationStats {
    let coldGraphs = 0;
    for (const id of this.manifest.keys()) if (!this.live.has(id)) coldGraphs += 1;
    return {
      residentElements: this.residentElements,
      liveGraphs: this.live.size,
      coldGraphs,
      hydrations: this.hydrations,
      evictions: this.evictions,
      overBudget: this.residentElements > this.maxResident,
    };
  }

  // ---------------------------------------------------------- observation

  /** Observation is explicit (ADR-0039 §5): sessions feed the cut's
   * dependency trace here; headless callers call it directly. */
  touch(ids: Iterable<GraphId>): void {
    this.touchClock += 1;
    for (const id of ids) this.lastTouch.set(id, this.touchClock);
  }

  pin(id: GraphId): void {
    this.pinned.add(id);
  }

  unpin(id: GraphId): void {
    this.pinned.delete(id);
  }

  // ------------------------------------------------------------ hydration

  /**
   * cold → hydrating → live. Coalesces concurrent requests; honors an
   * `AbortSignal` (abandoned drill-in aborts before the delta applies —
   * loads are not torn, they simply don't commit). Live is a no-op.
   */
  hydrate(id: GraphId, opts: { readonly signal?: AbortSignal } = {}): Promise<void> {
    const pending = this.inFlight.get(id);
    if (pending) return pending;
    if (this.live.has(id)) return Promise.resolve();
    if (!this.manifest.has(id)) {
      return Promise.reject(
        new MeridianError('unknown-graph', `hydrate: graph "${id}" is not in the project manifest`),
      );
    }
    if (!this.store.snapshot().graphs.has(id)) {
      return Promise.reject(
        new MeridianError(
          'hydration-unreachable',
          `hydrate: graph "${id}" has no shell in the space — hydrate its ancestors first (the space is a top slab, ADR-0039)`,
        ),
      );
    }
    const run = this.doHydrate(id, opts.signal).finally(() => {
      this.inFlight.delete(id);
    });
    this.inFlight.set(id, run);
    return run;
  }

  private async doHydrate(id: GraphId, signal: AbortSignal | undefined): Promise<void> {
    const throwIfAborted = (): void => {
      if (signal?.aborted) {
        throw new MeridianError('hydration-aborted', `hydrate: aborted for graph "${id}"`);
      }
    };
    throwIfAborted();
    const entry = this.manifest.get(id)!;
    this.evictBeforeHydration(entry.nodeCount + entry.edgeCount, id);
    throwIfAborted();
    const graph = await this.backend.loadGraph(id);
    throwIfAborted();

    if (graph === null) {
      if (entry.nodeCount + entry.edgeCount === 0) {
        this.live.add(id); // durably empty — nothing to materialize
        this.touch([id]);
        return;
      }
      throw new MeridianError(
        'hydration-missing',
        `hydrate: backend has no content for graph "${id}" although the manifest expects ${entry.nodeCount} nodes`,
      );
    }

    const ops: GraphOpInput[] = [];
    const space = this.store.snapshot();
    // Child shells first (a node:add claiming a detail graph requires the
    // graph to exist and be an unclaimed root) — the top-slab invariant:
    // hydrating G makes G's children exist at least as shells.
    const seenChildren = new Set<GraphId>();
    for (const node of graph.nodes.values()) {
      const child = node.detail?.graph;
      if (child === undefined || seenChildren.has(child) || space.graphs.has(child)) continue;
      seenChildren.add(child);
      const childEntry = this.manifest.get(child);
      if (childEntry === undefined) {
        throw new MeridianError(
          'hydration-missing',
          `hydrate: graph "${id}" references child graph "${child}" that is not in the manifest`,
        );
      }
      ops.push({ t: 'graph:add', graph: child, meta: childEntry.meta });
    }
    for (const node of graph.nodes.values()) ops.push({ t: 'node:add', graph: id, node });
    for (const edge of graph.edges.values()) ops.push({ t: 'edge:add', graph: id, edge });

    if (ops.length === 0) {
      this.live.add(id);
      this.touch([id]);
      return;
    }

    throwIfAborted();
    const applied = this.store.apply({ origin: { actor: this.actor, volatile: true }, ops });
    if (!applied.ok) {
      const first = applied.errors[0]!;
      throw new MeridianError(
        'hydration-failed',
        `hydrate: volatile delta for graph "${id}" rejected — [${first.code}] ${first.message}`,
      );
    }
    this.observeOwnChange(applied.changes);
    this.live.add(id);
    this.residentElements += graph.nodes.size + graph.edges.size;
    this.hydrations += 1;
    this.touch([id]);
    this.evictToBudget(id);
  }

  // ------------------------------------------------------------- eviction

  /** live ∧ unobserved-LRU ∧ unpinned ∧ not history-protected ∧ not a root
   * ∧ all children cold (deepest-first, ADR-0039 §4). */
  private isEvictable(id: GraphId): boolean {
    // A semantic commit mutates the store synchronously but reaches this
    // manager through an async subscription. Until that exact gap closes we
    // cannot know the undo-protection set or resident counts, so eviction is
    // conservatively disabled for every graph.
    if (!versionsEqual(this.lastObservedVersion, this.store.version())) return false;
    if (!this.live.has(id) || this.inFlight.has(id)) return false;
    if (this.pinned.has(id) || this.historyProtected.has(id)) return false;
    const space = this.store.snapshot();
    if (space.roots.includes(id)) return false;
    if (!this.manifest.has(id)) return false; // nothing durable to rehydrate from
    const graph = space.graphs.get(id);
    if (graph === undefined) return false;
    for (const node of graph.nodes.values()) {
      const child = node.detail?.graph;
      if (child !== undefined && (this.live.has(child) || this.inFlight.has(child))) {
        // A durably-empty child is live-by-definition but weightless; it
        // rides along with the parent instead of blocking eviction.
        const childEntry = this.manifest.get(child);
        if (childEntry === undefined || childEntry.nodeCount + childEntry.edgeCount > 0) return false;
      }
    }
    return true;
  }

  /**
   * live → cold: one volatile delta removes the graph's edges, its nodes
   * (releasing child claims), and its children's shells; the graph itself
   * stays as a shell. Nothing is written — the log already has it (§4.7);
   * `evictHint` is advisory.
   */
  evict(id: GraphId): boolean {
    if (!this.isEvictable(id)) return false;
    const space = this.store.snapshot();
    const graph = space.graphs.get(id)!;
    const size = graph.nodes.size + graph.edges.size;
    if (size === 0) return false; // shell or durably empty — nothing to drop

    const ops: GraphOpInput[] = [];
    const children: GraphId[] = [];
    for (const edge of graph.edges.values()) ops.push({ t: 'edge:remove', graph: id, id: edge.id });
    for (const node of graph.nodes.values()) {
      ops.push({ t: 'node:remove', graph: id, id: node.id });
      if (node.detail !== undefined) children.push(node.detail.graph);
    }
    for (const child of children.sort()) {
      const childGraph = space.graphs.get(child);
      if (childGraph !== undefined) ops.push({ t: 'graph:remove', graph: child });
    }

    const applied = this.store.apply({ origin: { actor: this.actor, volatile: true }, ops });
    if (!applied.ok) {
      const first = applied.errors[0]!;
      throw new MeridianError(
        'eviction-failed',
        `evict: volatile delta for graph "${id}" rejected — [${first.code}] ${first.message}`,
      );
    }
    this.observeOwnChange(applied.changes);
    this.live.delete(id);
    for (const child of children) this.live.delete(child); // drop weightless empty-live children
    this.residentElements -= size;
    this.evictions += 1;
    this.backend.evictHint([id, ...children]);
    return true;
  }

  /** Evict least-recently-touched evictable graphs until at or under the
   * low-water mark. Returns the number of evictions performed. */
  evictToBudget(exclude?: GraphId): number {
    if (this.residentElements <= this.maxResident) return 0;
    return this.evictLruUntil(
      this.lowWater,
      exclude === undefined ? undefined : new Set([exclude]),
    );
  }

  /** Use the durable manifest size to make room before loading a cold graph.
   * If the predicted post-hydration resident set crosses high water, drain
   * eligible LRU graphs far enough that adding the graph lands at low water.
   * Failure to make enough room never refuses hydration: correctness wins. */
  private evictBeforeHydration(incomingElements: number, exclude: GraphId): number {
    if (this.residentElements + incomingElements <= this.maxResident) return 0;
    return this.evictLruUntil(
      Math.max(0, this.lowWater - incomingElements),
      this.hydrationLineage(exclude),
    );
  }

  /** The target shell and every live ancestor that keeps it reachable must
   * survive pre-hydration eviction. The valid containment relation is a
   * forest, so each child has at most one parent. */
  private hydrationLineage(target: GraphId): ReadonlySet<GraphId> {
    const parentByChild = new Map<GraphId, GraphId>();
    for (const [parentId, graph] of this.store.snapshot().graphs) {
      for (const node of graph.nodes.values()) {
        if (node.detail !== undefined) parentByChild.set(node.detail.graph, parentId);
      }
    }
    const lineage = new Set<GraphId>([target]);
    let current = target;
    while (true) {
      const parent = parentByChild.get(current);
      if (parent === undefined || lineage.has(parent)) break;
      lineage.add(parent);
      current = parent;
    }
    return lineage;
  }

  private evictLruUntil(
    targetResidentElements: number,
    excluded?: ReadonlySet<GraphId>,
  ): number {
    const candidates = [...this.live]
      .filter((id) => excluded?.has(id) !== true && this.isEvictable(id))
      .sort((a, b) => {
        const ta = this.lastTouch.get(a) ?? 0;
        const tb = this.lastTouch.get(b) ?? 0;
        return ta !== tb ? ta - tb : a < b ? -1 : a > b ? 1 : 0;
      });
    let evicted = 0;
    for (const id of candidates) {
      if (this.residentElements <= targetResidentElements) break;
      if (this.evict(id)) evicted += 1;
    }
    return evicted;
  }

  dispose(): void {
    this.unsubscribe();
  }

  // ------------------------------------------------------------ internals

  /** Track semantic commits: undo protection, observation, manifest counts,
   * resident size. Volatile commits are this manager's own cache movements
   * and are already accounted at their call sites. */
  private onChange(change: ChangeSet): void {
    if (change.origin.volatile === true) {
      this.observeChange(change);
      return;
    }
    for (const g of change.touched.graphs) {
      this.historyProtected.add(g);
    }
    this.touch(change.touched.graphs);
    for (const op of change.ops) {
      switch (op.t) {
        case 'graph:add':
          this.manifest.set(op.graph, { meta: op.meta, nodeCount: 0, edgeCount: 0 });
          this.live.add(op.graph);
          break;
        case 'graph:remove':
          this.manifest.delete(op.graph);
          this.live.delete(op.graph);
          break;
        case 'graph:meta': {
          const entry = this.manifest.get(op.graph);
          if (entry) this.manifest.set(op.graph, { ...entry, meta: op.next });
          break;
        }
        case 'node:add':
          this.bumpCounts(op.graph, 1, 0);
          break;
        case 'node:remove':
          this.bumpCounts(op.graph, -1, 0);
          break;
        case 'edge:add':
          this.bumpCounts(op.graph, 0, 1);
          break;
        case 'edge:remove':
          this.bumpCounts(op.graph, 0, -1);
          break;
        default:
          break;
      }
    }
    this.observeChange(change);
  }

  /** Advance only across a contiguous version edge. Older notifications for
   * volatile commits may arrive after we accounted them synchronously; those
   * are harmless and must not move the watermark backwards. */
  private observeChange(change: ChangeSet): void {
    if (versionsEqual(this.lastObservedVersion, change.fromVersion)) {
      this.lastObservedVersion = change.toVersion;
    }
  }

  private observeOwnChange(change: ChangeSet): void {
    this.observeChange(change);
  }

  private bumpCounts(graph: GraphId, nodes: number, edges: number): void {
    const entry = this.manifest.get(graph);
    if (entry) {
      this.manifest.set(graph, {
        ...entry,
        nodeCount: entry.nodeCount + nodes,
        edgeCount: entry.edgeCount + edges,
      });
    }
    if (this.live.has(graph)) this.residentElements += nodes + edges;
  }
}
