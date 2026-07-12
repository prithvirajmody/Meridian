/**
 * Drill-in scope (ADR-0025): "the detail graph becomes the working root."
 * `subSpaceRootedAt` carves the sub-forest reachable from one graph out of a
 * `GraphSpace`, so the **real** `LodResolver` (`@meridian/abstraction`) can
 * resolve a drilled context exactly as it resolves the top forest — no special
 * "scoped resolve" path, no second write path. The parent node whose detail is
 * the new root is excluded, so `derivedRootsOf` derives the detail graph as the
 * sub-space's sole root.
 *
 * Pure over an immutable snapshot (P8): a value-in/value-out reachability walk,
 * no I/O, deterministic. Imports only view-model types (§20).
 */
import type { GraphId, GraphSpace, NodeId, SemanticGraph } from '@meridian/view-model';

/**
 * The sub-space whose root graph is `rootGraphId` and whose graphs are exactly
 * `rootGraphId` plus every detail graph transitively reachable from its nodes.
 * Returns `undefined` when `rootGraphId` is not a graph in `space`.
 *
 * The walk is cycle-guarded (a `seen` set): malformed spaces with a detail
 * cycle terminate rather than loop.
 */
export function subSpaceRootedAt(space: GraphSpace, rootGraphId: GraphId): GraphSpace | undefined {
  const root = space.graphs.get(rootGraphId);
  if (root === undefined) return undefined;

  const graphs = new Map<GraphId, SemanticGraph>();
  const stack: SemanticGraph[] = [root];
  while (stack.length > 0) {
    const graph = stack.pop()!;
    if (graphs.has(graph.id)) continue;
    graphs.set(graph.id, graph);
    for (const node of graph.nodes.values()) {
      const detailId = node.detail?.graph;
      if (detailId === undefined || graphs.has(detailId)) continue;
      const detail = space.graphs.get(detailId);
      if (detail !== undefined) stack.push(detail);
    }
  }
  return { graphs, roots: [rootGraphId] };
}

/**
 * The node whose `detail` graph is `graphId`, or `undefined` when `graphId` is
 * a forest root (contained by no node). Pure map lookup; used to derive
 * breadcrumbs from containment (ADR-0025: breadcrumbs are derived, never
 * stored).
 */
export function containingNode(
  space: GraphSpace,
): ReadonlyMap<GraphId, { readonly node: NodeId; readonly graph: GraphId }> {
  const out = new Map<GraphId, { node: NodeId; graph: GraphId }>();
  for (const graph of space.graphs.values()) {
    for (const node of graph.nodes.values()) {
      const detailId = node.detail?.graph;
      if (detailId !== undefined) out.set(detailId, { node: node.id, graph: graph.id });
    }
  }
  return out;
}
