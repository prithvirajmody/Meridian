/**
 * Derived containment accessors (ADR-0001, §4.2): the detail references are
 * the one canonical direction of truth; everything here is computed from
 * them, never stored. All functions are pure and never trigger I/O.
 */
import type { GraphId, NodeId } from './ids.js';
import type { GraphSpace, SemanticGraph, SemanticNode } from './model.js';

export interface ContainmentRecord {
  /** The graph holding the containing node. */
  readonly parentGraph: GraphId;
  /** The node whose detail is the child graph. */
  readonly parentNode: NodeId;
}

/** child graph → containing node, one pass. Duplicates keep the first
 * occurrence; the validator reports them as `multiple-containment`. */
export function buildContainmentIndex(
  space: GraphSpace,
): ReadonlyMap<GraphId, ContainmentRecord> {
  const index = new Map<GraphId, ContainmentRecord>();
  for (const graph of space.graphs.values()) {
    for (const node of graph.nodes.values()) {
      if (node.detail && !index.has(node.detail.graph)) {
        index.set(node.detail.graph, {
          parentGraph: graph.id,
          parentNode: node.id,
        });
      }
    }
  }
  return index;
}

export function containingNodeOf(
  space: GraphSpace,
  graphId: GraphId,
  index?: ReadonlyMap<GraphId, ContainmentRecord>,
): ContainmentRecord | undefined {
  return (index ?? buildContainmentIndex(space)).get(graphId);
}

export function detailGraphOf(
  space: GraphSpace,
  node: SemanticNode,
): SemanticGraph | undefined {
  return node.detail ? space.graphs.get(node.detail.graph) : undefined;
}

/**
 * Root-to-graph chain of graph IDs. Cycle-guarded: walking stops if a graph
 * repeats (invalid spaces), so callers always terminate.
 */
export function containmentPathOf(
  space: GraphSpace,
  graphId: GraphId,
  index?: ReadonlyMap<GraphId, ContainmentRecord>,
): GraphId[] {
  const idx = index ?? buildContainmentIndex(space);
  const path: GraphId[] = [graphId];
  const seen = new Set<GraphId>([graphId]);
  let current = idx.get(graphId);
  while (current) {
    if (seen.has(current.parentGraph)) break;
    seen.add(current.parentGraph);
    path.unshift(current.parentGraph);
    current = idx.get(current.parentGraph);
  }
  return path;
}

/** Graphs contained by no node, in sorted order (derived, never trusted). */
export function derivedRootsOf(
  space: GraphSpace,
  index?: ReadonlyMap<GraphId, ContainmentRecord>,
): GraphId[] {
  const idx = index ?? buildContainmentIndex(space);
  return [...space.graphs.keys()]
    .filter((id) => !idx.has(id))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
