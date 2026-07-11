/**
 * Connected components of the induced graph over a cut (ADR-0015 disconnected
 * components). The induced multigraph is collapsed to a **simple undirected**
 * graph over `cut.members` (direction and parallel kinds are irrelevant to
 * "are these two boxes related"); components are found by union-find in
 * ascending-`NodeId` order, so the partition is a deterministic function of
 * the input (I6). Isolated members (no induced edge) are singleton components.
 *
 * Pure; imports only the abstraction/graph-core *types* and layout's own I/O
 * types — no layout logic beyond this partition step.
 */
import type { InducedEdge } from '@meridian/abstraction';
import type { NodeId } from '@meridian/graph-core';

function compareIds(a: NodeId, b: NodeId): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Union-find over member ids, keyed by ascending-sorted index for
 * deterministic root selection. */
class UnionFind {
  private readonly parent: number[];
  private readonly rank: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Array(n).fill(0) as number[];
  }
  find(x: number): number {
    let r = x;
    while (this.parent[r] !== r) r = this.parent[r]!;
    // Path compression.
    let cur = x;
    while (this.parent[cur] !== r) {
      const next = this.parent[cur]!;
      this.parent[cur] = r;
      cur = next;
    }
    return r;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (this.rank[ra]! < this.rank[rb]!) {
      this.parent[ra] = rb;
    } else if (this.rank[ra]! > this.rank[rb]!) {
      this.parent[rb] = ra;
    } else {
      this.parent[rb] = ra;
      this.rank[ra]!++;
    }
  }
}

/**
 * Partition `members` into connected components over the undirected induced
 * graph. Returns each component as a `NodeId[]` sorted ascending, the whole
 * list ordered by ascending minimum member (deterministic; the caller re-sorts
 * for packing). Edges whose endpoints are not both members are ignored (they
 * cannot exist for a well-formed induced set, but the guard keeps this total).
 */
export function connectedComponents(
  members: readonly NodeId[],
  edges: readonly InducedEdge[],
): NodeId[][] {
  const index = new Map<NodeId, number>();
  members.forEach((m, i) => index.set(m, i));
  const uf = new UnionFind(members.length);
  for (const e of edges) {
    const a = index.get(e.src);
    const b = index.get(e.dst);
    if (a === undefined || b === undefined) continue;
    uf.union(a, b);
  }
  const buckets = new Map<number, NodeId[]>();
  members.forEach((m, i) => {
    const root = uf.find(i);
    (buckets.get(root) ?? buckets.set(root, []).get(root)!).push(m);
  });
  const components = [...buckets.values()];
  for (const c of components) c.sort(compareIds);
  // Order components by ascending minimum member for a stable starting order;
  // the packer re-sorts by (descending area, ascending minId).
  components.sort((x, y) => compareIds(x[0]!, y[0]!));
  return components;
}
