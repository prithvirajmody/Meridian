/**
 * A single-pass index of the containment forest, precomputed once per resolve
 * so the LOD descent, salience v1 (ADR-0014), and budget degradation are all
 * O(nodes + edges) rather than each re-walking the tree. Pure over an
 * immutable snapshot (P8); no I/O, deterministic ordering (nodes visited in
 * each graph's own map order, which the store keeps canonical).
 *
 * Everything the resolver needs about a node lives here: its parent (the
 * containing node, if any), containing graph, detail-graph children, depth,
 * subtree leaf count (its summary weight, I5), incident-edge degree (which is
 * exactly its induced-edge degree as a visible frontier member — see
 * `salience.ts`), and the recency signal rolled up over its subtree.
 */
import {
  detailGraphOf,
  type GraphId,
  type GraphSpace,
  type NodeId,
  type SemanticNode,
} from '@meridian/graph-core';
import { forestRootGraphs } from './forest.js';

/** Reserved recency attribute (ADR-0014): epoch-ms, newer = more salient. */
export const UPDATED_AT_ATTR = 'core:updated-at';
/** Reserved explicit-salience prior (ADR-0014, §8.1): replaces the computed
 * structural salience for the node that carries it. */
export const SALIENCE_ATTR = 'core:salience';

export interface ForestIndex {
  /** Every node id in the forest, in deterministic pre-order. */
  readonly nodes: readonly NodeId[];
  /** node → its `SemanticNode` (for attr reads). */
  readonly nodeOf: ReadonlyMap<NodeId, SemanticNode>;
  /** node → the graph it is a member of. */
  readonly graphOf: ReadonlyMap<NodeId, GraphId>;
  /** node → its containing node (absent for a root-graph node). */
  readonly parent: ReadonlyMap<NodeId, NodeId>;
  /** node → the node ids of its detail graph, `[]` when it is a leaf. */
  readonly children: ReadonlyMap<NodeId, readonly NodeId[]>;
  /** node → containment depth (root-graph nodes are depth 0). */
  readonly depth: ReadonlyMap<NodeId, number>;
  /** node → leaf count of its subtree (a leaf counts as 1). */
  readonly subtreeLeaves: ReadonlyMap<NodeId, number>;
  /** node → number of incident base edges in its own graph. */
  readonly incidentDegree: ReadonlyMap<NodeId, number>;
  /** node → max `core:updated-at` over its subtree (absent ⇒ no recency data
   * anywhere beneath it). */
  readonly recencyMax: ReadonlyMap<NodeId, number>;
  /** True when at least one node anywhere carries `core:updated-at`. */
  readonly hasRecency: boolean;
  /** True when the forest has at least one edge. */
  readonly hasEdges: boolean;
  /** Total leaves across the whole forest (I5 denominator). */
  readonly totalLeaves: number;
}

/** A leaf has no detail children. */
export function isLeafNode(index: ForestIndex, node: NodeId): boolean {
  return (index.children.get(node)?.length ?? 0) === 0;
}

function numericAttr(node: SemanticNode, key: string): number | undefined {
  const v = node.attrs[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Build the forest index in one pre-order DFS plus one edge scan. */
export function buildForestIndex(space: GraphSpace): ForestIndex {
  const nodes: NodeId[] = [];
  const nodeOf = new Map<NodeId, SemanticNode>();
  const graphOf = new Map<NodeId, GraphId>();
  const parent = new Map<NodeId, NodeId>();
  const children = new Map<NodeId, readonly NodeId[]>();
  const depth = new Map<NodeId, number>();
  const subtreeLeaves = new Map<NodeId, number>();
  const recencyMax = new Map<NodeId, number>();
  let hasRecency = false;

  // Returns [subtreeLeafCount, subtreeRecencyMax | undefined] for `node`.
  const visit = (
    node: SemanticNode,
    graph: GraphId,
    d: number,
    parentNode: NodeId | undefined,
  ): { leaves: number; recency: number | undefined } => {
    nodes.push(node.id);
    nodeOf.set(node.id, node);
    graphOf.set(node.id, graph);
    depth.set(node.id, d);
    if (parentNode !== undefined) parent.set(node.id, parentNode);

    const own = numericAttr(node, UPDATED_AT_ATTR);
    if (own !== undefined) hasRecency = true;
    let recency = own;

    const detail = detailGraphOf(space, node);
    if (detail === undefined || detail.nodes.size === 0) {
      children.set(node.id, []);
      subtreeLeaves.set(node.id, 1);
      if (recency !== undefined) recencyMax.set(node.id, recency);
      return { leaves: 1, recency };
    }

    const childIds: NodeId[] = [];
    let leaves = 0;
    for (const child of detail.nodes.values()) {
      childIds.push(child.id);
      const sub = visit(child, detail.id, d + 1, node.id);
      leaves += sub.leaves;
      if (sub.recency !== undefined) recency = recency === undefined ? sub.recency : Math.max(recency, sub.recency);
    }
    children.set(node.id, childIds);
    subtreeLeaves.set(node.id, leaves);
    if (recency !== undefined) recencyMax.set(node.id, recency);
    return { leaves, recency };
  };

  let totalLeaves = 0;
  for (const graph of forestRootGraphs(space)) {
    for (const node of graph.nodes.values()) totalLeaves += visit(node, graph.id, 0, undefined).leaves;
  }

  // Incident-edge degree. Base edges are intra-graph, so an edge (u,v) crosses
  // the subtree boundary of exactly nodes u and v — hence a node's incident
  // count *is* its induced-edge degree as a visible frontier member (ADR-0013,
  // used as the salience "degree" signal in `salience.ts`).
  const incidentDegree = new Map<NodeId, number>();
  let hasEdges = false;
  for (const graph of space.graphs.values()) {
    for (const edge of graph.edges.values()) {
      hasEdges = true;
      incidentDegree.set(edge.src, (incidentDegree.get(edge.src) ?? 0) + 1);
      incidentDegree.set(edge.dst, (incidentDegree.get(edge.dst) ?? 0) + 1);
    }
  }

  return {
    nodes,
    nodeOf,
    graphOf,
    parent,
    children,
    depth,
    subtreeLeaves,
    incidentDegree,
    recencyMax,
    hasRecency,
    hasEdges,
    totalLeaves,
  };
}
