/**
 * The fluent query API (ROADMAP Phase 1 §5): index-backed node lookup over
 * the store's current snapshot. Constraints AND-compose; results are
 * deterministic (sorted by id). Scope is deliberately capped to what
 * Phases 3–7 demonstrably need (byKind, within, text, neighbors).
 */
import type {
  EdgeId,
  GraphId,
  GraphSpace,
  NodeId,
  SemanticEdge,
  SemanticNode,
} from '@meridian/graph-core';
import { tokenizeLabel, type EngineIndices, type QueryIndices } from './indices.js';

export interface NeighborConstraint {
  readonly of: NodeId;
  readonly direction?: 'out' | 'in' | 'both';
  readonly edgeKind?: string;
}

export interface GraphQuery {
  /** Restrict to nodes of one graph. */
  within(graph: GraphId): GraphQuery;
  /** Exact namespaced kind. */
  byKind(kind: string): GraphQuery;
  /** Every whitespace/punctuation-separated token must match a label token. */
  text(q: string): GraphQuery;
  /** Restrict to nodes adjacent to `of` (same graph by construction, U1). */
  neighborsOf(of: NodeId, opts?: Omit<NeighborConstraint, 'of'>): GraphQuery;
  ids(): NodeId[];
  nodes(): SemanticNode[];
}

export class GraphQueryImpl implements GraphQuery {
  private readonly graphs: GraphId[] = [];
  private readonly kinds: string[] = [];
  private readonly tokens: string[] = [];
  private readonly neighbors: NeighborConstraint[] = [];

  constructor(
    private readonly space: () => GraphSpace,
    private readonly engine: EngineIndices,
    private readonly query: QueryIndices,
  ) {}

  within(graph: GraphId): GraphQuery {
    this.graphs.push(graph);
    return this;
  }

  byKind(kind: string): GraphQuery {
    this.kinds.push(kind);
    return this;
  }

  text(q: string): GraphQuery {
    this.tokens.push(...tokenizeLabel(q));
    return this;
  }

  neighborsOf(of: NodeId, opts: Omit<NeighborConstraint, 'of'> = {}): GraphQuery {
    this.neighbors.push({ of, ...opts });
    return this;
  }

  ids(): NodeId[] {
    return [...this.execute()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  nodes(): SemanticNode[] {
    const space = this.space();
    return this.ids().map((id) => {
      const graph = this.engine.nodeGraph.get(id)!;
      return space.graphs.get(graph)!.nodes.get(id)!;
    });
  }

  // -------------------------------------------------------------- execution

  private execute(): Set<NodeId> {
    const seeds: Array<ReadonlySet<NodeId>> = [];
    for (const kind of this.kinds) seeds.push(this.query.nodesByKind.get(kind) ?? new Set());
    for (const token of this.tokens) seeds.push(this.query.nodesByToken.get(token) ?? new Set());
    for (const n of this.neighbors) seeds.push(this.neighborSet(n));
    if (seeds.length === 0) {
      // Only graph restrictions (or nothing): enumerate graph contents.
      const space = this.space();
      const out = new Set<NodeId>();
      if (this.graphs.length > 0) {
        const [first, ...rest] = this.graphs;
        const g = space.graphs.get(first!);
        if (g) for (const id of g.nodes.keys()) out.add(id);
        return rest.length > 0 ? this.filterGraphs(out, rest) : out;
      }
      for (const g of space.graphs.values()) for (const id of g.nodes.keys()) out.add(id);
      return out;
    }
    seeds.sort((a, b) => a.size - b.size);
    const [smallest, ...others] = seeds;
    let result = new Set<NodeId>();
    for (const id of smallest!) {
      if (others.every((s) => s.has(id))) result.add(id);
    }
    if (this.graphs.length > 0) result = this.filterGraphs(result, this.graphs);
    return result;
  }

  private filterGraphs(ids: Set<NodeId>, graphs: readonly GraphId[]): Set<NodeId> {
    const out = new Set<NodeId>();
    for (const id of ids) {
      const owner = this.engine.nodeGraph.get(id);
      if (owner !== undefined && graphs.every((g) => g === owner)) out.add(id);
    }
    return out;
  }

  private neighborSet(c: NeighborConstraint): Set<NodeId> {
    const space = this.space();
    const direction = c.direction ?? 'both';
    const out = new Set<NodeId>();
    const collect = (edgeIds: ReadonlySet<EdgeId>, pick: (e: SemanticEdge) => NodeId) => {
      for (const edgeId of edgeIds) {
        const graphId = this.engine.edgeGraph.get(edgeId);
        const edge = graphId !== undefined ? space.graphs.get(graphId)?.edges.get(edgeId) : undefined;
        if (!edge) continue;
        if (c.edgeKind !== undefined && edge.kind !== c.edgeKind) continue;
        out.add(pick(edge));
      }
    };
    if (direction !== 'in') collect(this.engine.adjOut.get(c.of) ?? new Set(), (e) => e.dst);
    if (direction !== 'out') collect(this.engine.adjIn.get(c.of) ?? new Set(), (e) => e.src);
    return out;
  }
}
