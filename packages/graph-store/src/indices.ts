/**
 * Incremental indices (ADR-0006): mutable, head-only, derived state — never
 * authoritative, always rebuildable from the snapshot (equivalence is
 * property-tested). Engine indices serve op preconditions; query indices
 * serve the fluent query API. In-flight transactions read through an
 * overlay; the base is untouched until commit, so rollback is free.
 */
import type {
  EdgeId,
  GraphId,
  GraphSpace,
  NodeId,
  SemanticNode,
} from '@meridian/graph-core';
import type { GraphOp } from './ops.js';

export interface ContainmentRecord {
  readonly parentGraph: GraphId;
  readonly parentNode: NodeId;
}

/** What op preconditions need: O(1) location, adjacency, containment. */
export interface EngineIndices {
  /** node id → owning graph (node ids are globally unique, U-duplicates). */
  readonly nodeGraph: Map<NodeId, GraphId>;
  readonly edgeGraph: Map<EdgeId, GraphId>;
  readonly adjOut: Map<NodeId, Set<EdgeId>>;
  readonly adjIn: Map<NodeId, Set<EdgeId>>;
  /** child graph → the node whose detail it is (absent = root). */
  readonly containment: Map<GraphId, ContainmentRecord>;
}

export function buildEngineIndices(space: GraphSpace): EngineIndices {
  const nodeGraph = new Map<NodeId, GraphId>();
  const edgeGraph = new Map<EdgeId, GraphId>();
  const adjOut = new Map<NodeId, Set<EdgeId>>();
  const adjIn = new Map<NodeId, Set<EdgeId>>();
  const containment = new Map<GraphId, ContainmentRecord>();
  for (const graph of space.graphs.values()) {
    for (const node of graph.nodes.values()) {
      nodeGraph.set(node.id, graph.id);
      adjOut.set(node.id, new Set());
      adjIn.set(node.id, new Set());
      if (node.detail) {
        containment.set(node.detail.graph, { parentGraph: graph.id, parentNode: node.id });
      }
    }
    for (const edge of graph.edges.values()) {
      edgeGraph.set(edge.id, graph.id);
      adjOut.get(edge.src)!.add(edge.id);
      adjIn.get(edge.dst)!.add(edge.id);
    }
  }
  return { nodeGraph, edgeGraph, adjOut, adjIn, containment };
}

const DELETED = Symbol('deleted');

/**
 * Read-through overlay over EngineIndices. All mutation during op
 * application lands here; `fold` applies it to the base after commit.
 */
export class EngineIndexView {
  private readonly nodeGraphW = new Map<NodeId, GraphId | typeof DELETED>();
  private readonly edgeGraphW = new Map<EdgeId, GraphId | typeof DELETED>();
  /** Working adjacency sets, copied per node on first write. */
  private readonly adjOutW = new Map<NodeId, Set<EdgeId> | typeof DELETED>();
  private readonly adjInW = new Map<NodeId, Set<EdgeId> | typeof DELETED>();
  private readonly containmentW = new Map<GraphId, ContainmentRecord | typeof DELETED>();

  constructor(private readonly base: EngineIndices) {}

  nodeGraphOf(id: NodeId): GraphId | undefined {
    const w = this.nodeGraphW.get(id);
    if (w !== undefined) return w === DELETED ? undefined : w;
    return this.base.nodeGraph.get(id);
  }

  edgeGraphOf(id: EdgeId): GraphId | undefined {
    const w = this.edgeGraphW.get(id);
    if (w !== undefined) return w === DELETED ? undefined : w;
    return this.base.edgeGraph.get(id);
  }

  containmentOf(graph: GraphId): ContainmentRecord | undefined {
    const w = this.containmentW.get(graph);
    if (w !== undefined) return w === DELETED ? undefined : w;
    return this.base.containment.get(graph);
  }

  outOf(id: NodeId): ReadonlySet<EdgeId> {
    const w = this.adjOutW.get(id);
    if (w !== undefined) return w === DELETED ? new Set() : w;
    return this.base.adjOut.get(id) ?? new Set();
  }

  inOf(id: NodeId): ReadonlySet<EdgeId> {
    const w = this.adjInW.get(id);
    if (w !== undefined) return w === DELETED ? new Set() : w;
    return this.base.adjIn.get(id) ?? new Set();
  }

  degreeOf(id: NodeId): number {
    return this.outOf(id).size + this.inOf(id).size;
  }

  addNode(id: NodeId, graph: GraphId): void {
    this.nodeGraphW.set(id, graph);
    this.adjOutW.set(id, new Set());
    this.adjInW.set(id, new Set());
  }

  removeNode(id: NodeId): void {
    this.nodeGraphW.set(id, DELETED);
    this.adjOutW.set(id, DELETED);
    this.adjInW.set(id, DELETED);
  }

  addEdge(id: EdgeId, graph: GraphId, src: NodeId, dst: NodeId): void {
    this.edgeGraphW.set(id, graph);
    this.outSetForWrite(src).add(id);
    this.inSetForWrite(dst).add(id);
  }

  removeEdge(id: EdgeId, src: NodeId, dst: NodeId): void {
    this.edgeGraphW.set(id, DELETED);
    this.outSetForWrite(src).delete(id);
    this.inSetForWrite(dst).delete(id);
  }

  setContainment(child: GraphId, record: ContainmentRecord): void {
    this.containmentW.set(child, record);
  }

  clearContainment(child: GraphId): void {
    this.containmentW.set(child, DELETED);
  }

  private outSetForWrite(id: NodeId): Set<EdgeId> {
    const w = this.adjOutW.get(id);
    if (w !== undefined && w !== DELETED) return w;
    const copy = new Set(w === DELETED ? [] : (this.base.adjOut.get(id) ?? []));
    this.adjOutW.set(id, copy);
    return copy;
  }

  private inSetForWrite(id: NodeId): Set<EdgeId> {
    const w = this.adjInW.get(id);
    if (w !== undefined && w !== DELETED) return w;
    const copy = new Set(w === DELETED ? [] : (this.base.adjIn.get(id) ?? []));
    this.adjInW.set(id, copy);
    return copy;
  }

  /** Fold the overlay into the base — only after a successful commit. */
  fold(): void {
    for (const [id, v] of this.nodeGraphW) {
      if (v === DELETED) this.base.nodeGraph.delete(id);
      else this.base.nodeGraph.set(id, v);
    }
    for (const [id, v] of this.edgeGraphW) {
      if (v === DELETED) this.base.edgeGraph.delete(id);
      else this.base.edgeGraph.set(id, v);
    }
    for (const [id, v] of this.adjOutW) {
      if (v === DELETED) this.base.adjOut.delete(id);
      else this.base.adjOut.set(id, v);
    }
    for (const [id, v] of this.adjInW) {
      if (v === DELETED) this.base.adjIn.delete(id);
      else this.base.adjIn.set(id, v);
    }
    for (const [id, v] of this.containmentW) {
      if (v === DELETED) this.base.containment.delete(id);
      else this.base.containment.set(id, v);
    }
  }
}

// -------------------------------------------------------------- query side

/** Label tokenization contract for the text index and `query().text()`. */
export function tokenizeLabel(label: string): string[] {
  return label
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

export interface QueryIndices {
  readonly nodesByKind: Map<string, Set<NodeId>>;
  readonly nodesByToken: Map<string, Set<NodeId>>;
}

export function buildQueryIndices(space: GraphSpace): QueryIndices {
  const nodesByKind = new Map<string, Set<NodeId>>();
  const nodesByToken = new Map<string, Set<NodeId>>();
  for (const graph of space.graphs.values()) {
    for (const node of graph.nodes.values()) indexNode(nodesByKind, nodesByToken, node);
  }
  return { nodesByKind, nodesByToken };
}

function indexNode(
  byKind: Map<string, Set<NodeId>>,
  byToken: Map<string, Set<NodeId>>,
  node: SemanticNode,
): void {
  let kindSet = byKind.get(node.kind);
  if (!kindSet) byKind.set(node.kind, (kindSet = new Set()));
  kindSet.add(node.id);
  for (const token of new Set(tokenizeLabel(node.label))) {
    let tokenSet = byToken.get(token);
    if (!tokenSet) byToken.set(token, (tokenSet = new Set()));
    tokenSet.add(node.id);
  }
}

function unindexNode(
  byKind: Map<string, Set<NodeId>>,
  byToken: Map<string, Set<NodeId>>,
  node: SemanticNode,
): void {
  const kindSet = byKind.get(node.kind);
  if (kindSet) {
    kindSet.delete(node.id);
    if (kindSet.size === 0) byKind.delete(node.kind);
  }
  for (const token of new Set(tokenizeLabel(node.label))) {
    const tokenSet = byToken.get(token);
    if (tokenSet) {
      tokenSet.delete(node.id);
      if (tokenSet.size === 0) byToken.delete(token);
    }
  }
}

/**
 * Post-commit incremental maintenance: kind/token membership only changes on
 * node add/remove (label and kind changes are remove + re-add in vocabulary
 * v1 — ADR-0005), so replaying the committed ops is exact.
 */
export function updateQueryIndices(qi: QueryIndices, ops: readonly GraphOp[]): void {
  for (const op of ops) {
    if (op.t === 'node:add') indexNode(qi.nodesByKind, qi.nodesByToken, op.node);
    else if (op.t === 'node:remove') unindexNode(qi.nodesByKind, qi.nodesByToken, op.prev);
  }
}
