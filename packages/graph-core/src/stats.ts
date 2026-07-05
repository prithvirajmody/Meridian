/**
 * Headless space statistics (ROADMAP Phase 0 §6). Pure, single-pass, and
 * cycle-safe (works on invalid spaces so the CLI can describe them).
 */
import type { GraphId } from './ids.js';
import type { GraphSpace } from './model.js';
import { buildContainmentIndex } from './traverse.js';

export interface SpaceStats {
  readonly graphs: number;
  readonly nodes: number;
  readonly edges: number;
  readonly roots: number;
  /** Containment levels; a lone root graph has depth 1, empty space 0. */
  readonly maxDepth: number;
  readonly nodesWithDetail: number;
  readonly nodesByKind: Readonly<Record<string, number>>;
  readonly edgesByKind: Readonly<Record<string, number>>;
}

function sortedCounts(counts: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of [...counts.keys()].sort()) out[key] = counts.get(key)!;
  return out;
}

export function stats(space: GraphSpace): SpaceStats {
  let nodes = 0;
  let edges = 0;
  let nodesWithDetail = 0;
  const nodesByKind = new Map<string, number>();
  const edgesByKind = new Map<string, number>();

  for (const graph of space.graphs.values()) {
    nodes += graph.nodes.size;
    edges += graph.edges.size;
    for (const node of graph.nodes.values()) {
      if (node.detail) nodesWithDetail++;
      nodesByKind.set(node.kind, (nodesByKind.get(node.kind) ?? 0) + 1);
    }
    for (const edge of graph.edges.values()) {
      edgesByKind.set(edge.kind, (edgesByKind.get(edge.kind) ?? 0) + 1);
    }
  }

  // Depth over the containment forest (children lists from detail refs),
  // iterative DFS from derived roots, visited-guarded against cycles.
  const index = buildContainmentIndex(space);
  const children = new Map<GraphId, GraphId[]>();
  for (const [child, record] of index) {
    const list = children.get(record.parentGraph);
    if (list) list.push(child);
    else children.set(record.parentGraph, [child]);
  }
  let maxDepth = 0;
  const visited = new Set<GraphId>();
  for (const graphId of space.graphs.keys()) {
    if (index.has(graphId)) continue; // not a root
    const stack: Array<[GraphId, number]> = [[graphId, 1]];
    while (stack.length > 0) {
      const [current, depth] = stack.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      if (depth > maxDepth) maxDepth = depth;
      for (const child of children.get(current) ?? []) stack.push([child, depth + 1]);
    }
  }

  return {
    graphs: space.graphs.size,
    nodes,
    edges,
    roots: space.roots.length,
    maxDepth,
    nodesWithDetail,
    nodesByKind: sortedCounts(nodesByKind),
    edgesByKind: sortedCounts(edgesByKind),
  };
}
