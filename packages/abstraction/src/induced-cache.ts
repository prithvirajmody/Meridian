/**
 * Incremental induced-edge cache (ADR-0013, "Cache & exact invalidation";
 * §5.5; ROADMAP Phase 3 §12 — the perf cliff). Holds per-visible-node
 * outgoing induced adjacency for a **fixed** cut, plus a cover index (node →
 * visible ancestor). On a committed P1 `ChangeSet` it recomputes *exactly* the
 * members whose adjacency the change can touch — never the whole cut — so a
 * one-edge edit costs one or two member recomputes, not a full re-aggregation.
 *
 * Invalidation is **exact, not conservative** (§5.5): base edges are
 * intra-graph and `edge:add`/`edge:remove` record both endpoints in
 * `touched.nodes`, so the affected members are precisely those endpoints'
 * visible ancestors. Structure-preserving changes (edge add/remove, attr, meta)
 * are handled incrementally; changes that reshape the containment forest
 * (node add/remove, detail rewire, graph add/remove) can move the cut itself,
 * so they raise {@link CutStaleError} — the cover index is rebuilt by
 * constructing a fresh cache for the new cut, per the ADR's top-level
 * `(storeVersion, cutHash)` key.
 *
 * Stateful, but never mutated in place by callers: the only reads are pure
 * snapshots ({@link InducedEdgeCache.resolve}).
 */
import { MeridianError, type GraphId, type GraphSpace, type NodeId } from '@meridian/graph-core';
import type { ChangeSet, GraphOp } from '@meridian/graph-store';
import type { Cut } from './cut.js';
import {
  buildNodeCover,
  compareInduced,
  inducedAdjacency,
  memberAdjacency,
  type InducedEdge,
} from './induced.js';

/** Raised when a `ChangeSet` may have moved the cut, so the cover index (and
 * thus this cache) is stale and a fresh cache must be built for the new cut. */
export class CutStaleError extends MeridianError {
  constructor(op: GraphOp['t']) {
    super(
      'cut-stale',
      `induced-edge cache: op "${op}" can reshape the containment forest and move the cut — ` +
        `rebuild the cut and construct a fresh cache (ADR-0013 keys the cache by (storeVersion, cutHash))`,
    );
  }
}

/** Ops that preserve the containment forest (and hence the cut): only edges,
 * attributes, and graph meta. Everything else can change which nodes the cut
 * covers, invalidating the cover index. */
function isStructurePreserving(op: GraphOp['t']): boolean {
  return op === 'edge:add' || op === 'edge:remove' || op === 'node:attr' || op === 'graph:meta';
}

function compareIds(a: NodeId, b: NodeId): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class InducedEdgeCache {
  private space: GraphSpace;
  private readonly cut: Cut;
  /** node → visible ancestor `A(node)` (absent ⇒ above the cut). */
  private cover: ReadonlyMap<NodeId, NodeId>;
  /** member → the graph it is a node of. */
  private readonly memberGraph: ReadonlyMap<NodeId, GraphId>;
  /** member → its outgoing induced edges, sorted by `(dst, kind)`. */
  private readonly adjacency: Map<NodeId, InducedEdge[]>;
  /** Members recomputed by the most recent {@link applyChange} (for the
   * op-count exactness assertion; ROADMAP Phase 3 §12). */
  private lastRecomputed: readonly NodeId[] = [];

  constructor(space: GraphSpace, cut: Cut) {
    this.space = space;
    this.cut = cut;
    this.cover = buildNodeCover(space, cut);
    const memberGraph = new Map<NodeId, GraphId>();
    for (const member of cut.members) {
      const rec = cut.trace.get(member);
      if (rec !== undefined) memberGraph.set(member, rec.graph);
    }
    this.memberGraph = memberGraph;
    this.adjacency = inducedAdjacency(space, cut, this.cover);
  }

  /** The complete induced-edge set for the cut, sorted by `(src, dst, kind)`
   * — identical to `aggregateEdges(space, cut)` at the current version. */
  resolve(): InducedEdge[] {
    const out: InducedEdge[] = [];
    for (const member of this.cut.members) {
      const bucket = this.adjacency.get(member);
      if (bucket !== undefined) out.push(...bucket);
    }
    // Buckets are per-member sorted and members are ascending, so the
    // concatenation is already globally ordered; the sort is a cheap guard.
    out.sort(compareInduced);
    return out;
  }

  /** The members recomputed by the last {@link applyChange}, ascending. */
  get recomputedMembers(): readonly NodeId[] {
    return this.lastRecomputed;
  }

  /**
   * Fold a committed `ChangeSet` into the cache, recomputing only the members
   * whose adjacency it can affect. `newSpace` is the post-change snapshot
   * (`store.snapshot()` after `apply`). Returns the recomputed members.
   * Throws {@link CutStaleError} if any op can move the cut.
   */
  applyChange(change: ChangeSet, newSpace: GraphSpace): readonly NodeId[] {
    for (const op of change.ops) {
      if (!isStructurePreserving(op.t)) throw new CutStaleError(op.t);
    }
    this.space = newSpace;

    // Affected members = the visible ancestors of the touched nodes. For an
    // edge op both endpoints are touched, so this is exactly {A(u), A(v)}.
    const affected = new Set<NodeId>();
    for (const node of change.touched.nodes) {
      const member = this.cover.get(node);
      if (member !== undefined && this.adjacency.has(member)) affected.add(member);
    }

    for (const member of affected) {
      const graphId = this.memberGraph.get(member);
      const graph = graphId !== undefined ? newSpace.graphs.get(graphId) : undefined;
      this.adjacency.set(member, memberAdjacency(newSpace, member, graph, this.cover));
    }

    this.lastRecomputed = [...affected].sort(compareIds);
    return this.lastRecomputed;
  }
}
