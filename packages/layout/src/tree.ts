/**
 * The `tree` provider (ROADMAP Phase 4 §3): a deterministic hierarchical
 * fallback for containment-shaped cuts. Within each connected component
 * (ADR-0015) it derives a spanning tree from the directed induced edges —
 * roots are members with no incoming induced edge (ascending `NodeId`; a purely
 * cyclic component roots at its minimum member) — and lays it out tidily:
 * depth sets the layer axis, a post-order leaf counter sets the breadth axis,
 * and each internal node centers over its children. Components are then
 * shelf-packed into the world plane.
 *
 * Every traversal and tie-break resolves by ascending `NodeId`, so identical
 * input yields byte-identical geometry (I6). MAIN-THREAD (no worker until 4C);
 * `signal` is accepted per contract but ignored. Zero-size nodes place as
 * degenerate point-rects (ADR-0015); a missing size is treated as zero.
 */
import type { InducedEdge, NodeId } from '@meridian/view-model';
import type { Rect, Size } from './coords.js';
import { connectedComponents } from './components.js';
import {
  boundsOf,
  DEFAULT_SPACING,
  EMPTY_BOUNDS,
  packComponents,
  type LaidOutComponent,
} from './geometry.js';
import { stabilityScore } from './stability.js';
import type { LayoutDirection, LayoutInput, LayoutProvider, LayoutResult } from './types.js';

const ZERO_SIZE: Size = { width: 0, height: 0 };

function compareIds(a: NodeId, b: NodeId): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Lay out one component as a tidy tree over its induced spanning forest. */
function treeComponent(
  members: readonly NodeId[],
  edges: readonly InducedEdge[],
  sizes: ReadonlyMap<NodeId, Size>,
  spacing: number,
  direction: LayoutDirection,
): LaidOutComponent {
  const memberSet = new Set(members);
  const childSets = new Map<NodeId, Set<NodeId>>();
  const indeg = new Map<NodeId, number>();
  for (const m of members) indeg.set(m, 0);
  for (const e of edges) {
    if (e.src === e.dst || !memberSet.has(e.src) || !memberSet.has(e.dst)) continue;
    let kids = childSets.get(e.src);
    if (kids === undefined) childSets.set(e.src, (kids = new Set<NodeId>()));
    if (!kids.has(e.dst)) {
      kids.add(e.dst);
      indeg.set(e.dst, indeg.get(e.dst)! + 1);
    }
  }
  const childrenOf = (n: NodeId): NodeId[] => [...(childSets.get(n) ?? [])].sort(compareIds);

  const visited = new Set<NodeId>();
  const depthOf = new Map<NodeId, number>();
  const slotOf = new Map<NodeId, number>();
  let nextLeaf = 0;

  const dfs = (node: NodeId, depth: number): void => {
    visited.add(node);
    depthOf.set(node, depth);
    const kidSlots: number[] = [];
    for (const kid of childrenOf(node)) {
      if (visited.has(kid)) continue;
      dfs(kid, depth + 1);
      kidSlots.push(slotOf.get(kid)!);
    }
    if (kidSlots.length === 0) {
      slotOf.set(node, nextLeaf++);
    } else {
      slotOf.set(node, kidSlots.reduce((a, b) => a + b, 0) / kidSlots.length);
    }
  };

  // Roots first (indegree 0, ascending); a cyclic component with no such root
  // starts at its minimum member; any member still unvisited becomes a root.
  const roots = members.filter((m) => indeg.get(m) === 0);
  const rootOrder = roots.length > 0 ? roots : [members[0]!];
  for (const r of rootOrder) if (!visited.has(r)) dfs(r, 0);
  for (const m of members) if (!visited.has(m)) dfs(m, 0);

  let colW = 0;
  let rowH = 0;
  for (const m of members) {
    const s = sizes.get(m) ?? ZERO_SIZE;
    if (s.width > colW) colW = s.width;
    if (s.height > rowH) rowH = s.height;
  }

  const local = new Map<NodeId, Rect>();
  for (const m of members) {
    const s = sizes.get(m) ?? ZERO_SIZE;
    const slot = slotOf.get(m)!;
    const depth = depthOf.get(m)!;
    const x = direction === 'right' ? depth * (colW + spacing) : slot * (colW + spacing);
    const y = direction === 'right' ? slot * (rowH + spacing) : depth * (rowH + spacing);
    local.set(m, { x, y, width: s.width, height: s.height });
  }
  return { local, members };
}

export const treeProvider: LayoutProvider = {
  id: 'tree',
  capabilities: { incremental: false, compound: false, deterministic: true },
  compute(input: LayoutInput, prev?: LayoutResult): Promise<LayoutResult> {
    const { cut, edges, sizes, hints } = input;
    const spacing = hints.spacing !== undefined && hints.spacing >= 0 ? hints.spacing : DEFAULT_SPACING;
    const direction: LayoutDirection = hints.direction ?? 'down';

    if (cut.members.length === 0) {
      const result: LayoutResult = { positions: new Map<NodeId, Rect>(), bounds: EMPTY_BOUNDS, stability: 1 };
      return Promise.resolve(result);
    }

    const components = connectedComponents(cut.members, edges).map((members) =>
      treeComponent(members, edges, sizes, spacing, direction),
    );
    const positions = packComponents(components, spacing);
    const bounds = boundsOf(positions.values());
    const draft: LayoutResult = { positions, bounds, stability: 1 };
    const { stability } = stabilityScore(prev, draft, hints);
    return Promise.resolve({ ...draft, stability });
  },
};
