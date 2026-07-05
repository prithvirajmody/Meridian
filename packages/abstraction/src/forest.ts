/**
 * The containment *forest of nodes* (ARCHITECTURE.md §5.1, §4.2): the tree
 * cuts are taken through. Its roots are the nodes of the space's root graphs
 * (depth 0); a node's children are the nodes of its `detail` graph; a leaf is
 * a node with no descendable detail. Everything here is a pure walk over an
 * immutable snapshot (P8) — no I/O, no mutation, deterministic ordering.
 *
 * Cold/unhydrated detail (§4.7) does not exist yet (Phase 11); a node whose
 * detail graph is absent or empty is treated as a leaf, which is exactly how
 * a cold node will be treated ("collapsed by necessity").
 */
import {
  derivedRootsOf,
  detailGraphOf,
  type GraphId,
  type GraphSpace,
  type NodeId,
  type SemanticGraph,
} from '@meridian/graph-core';

/** A leaf of the forest with the node at every depth on its root→leaf path.
 * `ancestors[d]` is the covering node at depth `d`; `ancestors[depth]` is the
 * leaf itself, so `ancestors.length === depth + 1`. */
export interface LeafPath {
  readonly leaf: NodeId;
  readonly graph: GraphId;
  readonly depth: number;
  readonly ancestors: readonly NodeId[];
}

/** True when `node` in `graph` cannot be descended into: no detail graph, or
 * a detail graph with no nodes (Phase 11's cold state resolves here too). */
export function isLeaf(space: GraphSpace, graph: SemanticGraph, nodeId: NodeId): boolean {
  const node = graph.nodes.get(nodeId);
  if (node === undefined) return true;
  const detail = detailGraphOf(space, node);
  return detail === undefined || detail.nodes.size === 0;
}

/** The forest's root graphs, derived from containment (never trusting the
 * stored `roots` array), sorted for deterministic traversal. */
function rootGraphs(space: GraphSpace): SemanticGraph[] {
  return derivedRootsOf(space).map((id) => {
    const graph = space.graphs.get(id);
    if (graph === undefined) {
      throw new Error(`abstraction: derived root "${id}" is not a graph in the space`);
    }
    return graph;
  });
}

/** Every root→leaf path in the forest, in a deterministic pre-order. */
export function collectLeafPaths(space: GraphSpace): LeafPath[] {
  const out: LeafPath[] = [];
  const visit = (graph: SemanticGraph, depth: number, ancestors: readonly NodeId[]): void => {
    for (const node of graph.nodes.values()) {
      const chain = [...ancestors, node.id];
      const detail = detailGraphOf(space, node);
      if (detail === undefined || detail.nodes.size === 0) {
        out.push({ leaf: node.id, graph: graph.id, depth, ancestors: chain });
      } else {
        visit(detail, depth + 1, chain);
      }
    }
  };
  for (const graph of rootGraphs(space)) visit(graph, 0, []);
  return out;
}

/** Deepest node depth in the forest, or `-1` when there are no nodes. */
export function maxDepth(space: GraphSpace): number {
  let max = -1;
  const visit = (graph: SemanticGraph, depth: number): void => {
    for (const node of graph.nodes.values()) {
      if (depth > max) max = depth;
      const detail = detailGraphOf(space, node);
      if (detail !== undefined && detail.nodes.size > 0) visit(detail, depth + 1);
    }
  };
  for (const graph of rootGraphs(space)) visit(graph, 0);
  return max;
}

/** Number of leaves in the subtree rooted at `nodeId` of `graph` (a leaf
 * counts as 1). Independent of the cut — used to prove coverage (I5). */
export function countSubtreeLeaves(
  space: GraphSpace,
  graph: SemanticGraph,
  nodeId: NodeId,
): number {
  const node = graph.nodes.get(nodeId);
  if (node === undefined) return 0;
  const detail = detailGraphOf(space, node);
  if (detail === undefined || detail.nodes.size === 0) return 1;
  let sum = 0;
  for (const child of detail.nodes.values()) sum += countSubtreeLeaves(space, detail, child.id);
  return sum;
}

/** Total leaves across the whole forest (Σ over root nodes). */
export function totalLeaves(space: GraphSpace): number {
  let sum = 0;
  for (const graph of rootGraphs(space)) {
    for (const node of graph.nodes.values()) sum += countSubtreeLeaves(space, graph, node.id);
  }
  return sum;
}

export { rootGraphs as forestRootGraphs };
