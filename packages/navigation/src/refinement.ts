/**
 * The `RefinementMap` (ADR-0023): the cut-diff correspondence, **derived (never
 * stored) from containment**. For a cut change `from → to` over one containment
 * forest, every node is classified as `move` / `enter` / `exit`, and each
 * entering/exiting node gets its source/target from containment:
 *
 * - `move`  — node in both cuts (same `NodeId`).
 * - `enter` — node only in `to`. Its **source** is its nearest ancestor in
 *   `from` (refinement) or, failing that, its descendants in `from`
 *   (coarsening under overrides), else sourceless.
 * - `exit`  — node only in `from`. Its **target** is its nearest ancestor in
 *   `to` (coarsening) or its descendants in `to` (refinement), else targetless.
 *
 * Because both cuts are covering antichains (I5), an entering/exiting node has
 * **at most one** nearest ancestor in the other cut and cannot have both an
 * ancestor and descendants there — ties cannot occur. Derivation is a pure
 * function of `(fromCut, toCut, space)`; sourceless/targetless nodes are legal
 * (a subtree added/removed by a delta) and surface in the plan diagnostics.
 */
import { buildForestIndex, type Cut, type ForestIndex } from '@meridian/abstraction';
import type { GraphSpace, NodeId } from '@meridian/view-model';

/** How an entering node's source / an exiting node's target was found. */
export type CorrespondenceKind = 'ancestor' | 'descendants' | 'none';

/** An entering node (in `to`, not `from`) and where it spawns from. */
export interface EnterEntry {
  readonly id: NodeId;
  readonly sourceKind: CorrespondenceKind;
  /** The nearest ancestor in `from`, when `sourceKind === 'ancestor'`. */
  readonly source?: NodeId;
  /** The `from`-cut descendants, ascending, when `sourceKind === 'descendants'`. */
  readonly sourceDescendants?: readonly NodeId[];
}

/** An exiting node (in `from`, not `to`) and where it merges to. */
export interface ExitEntry {
  readonly id: NodeId;
  readonly targetKind: CorrespondenceKind;
  /** The nearest ancestor in `to`, when `targetKind === 'ancestor'`. */
  readonly target?: NodeId;
  /** The `to`-cut descendants, ascending, when `targetKind === 'descendants'`. */
  readonly targetDescendants?: readonly NodeId[];
}

/** The derived enter/exit/move sets for a cut change (ADR-0023). */
export interface RefinementMap {
  /** Nodes in both cuts, ascending `NodeId`. */
  readonly move: readonly NodeId[];
  /** Nodes only in `to`, ascending `NodeId`. */
  readonly enter: readonly EnterEntry[];
  /** Nodes only in `from`, ascending `NodeId`. */
  readonly exit: readonly ExitEntry[];
}

function compareIds(a: NodeId, b: NodeId): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The nearest strict ancestor of `id` that is a member of `set`, else none. */
function nearestAncestorInSet(index: ForestIndex, id: NodeId, set: ReadonlySet<NodeId>): NodeId | undefined {
  let cur = index.parent.get(id);
  while (cur !== undefined) {
    if (set.has(cur)) return cur;
    cur = index.parent.get(cur);
  }
  return undefined;
}

/**
 * The members of `set` that are strict descendants of `id`, ascending. Walks
 * `id`'s subtree and stops descending past any member (both cuts are
 * antichains, so a member has no member beneath it) — so the result is `id`'s
 * covering frontier within `set`.
 */
function descendantsInSet(index: ForestIndex, id: NodeId, set: ReadonlySet<NodeId>): NodeId[] {
  const out: NodeId[] = [];
  const stack = [...(index.children.get(id) ?? [])];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (set.has(n)) {
      out.push(n);
      continue; // antichain: do not descend past a member
    }
    const children = index.children.get(n);
    if (children !== undefined) for (const c of children) stack.push(c);
  }
  out.sort(compareIds);
  return out;
}

/**
 * Derive the refinement correspondence for a cut change. Pure and
 * deterministic (I6): enter/exit are emitted in the source cuts' ascending
 * member order, and descendant lists are sorted, so identical inputs yield a
 * deep-equal map. A node present in a cut but absent from the containment
 * forest (removed by a concurrent mutation) resolves to `'none'` — the honest,
 * non-throwing reading ADR-0024 calls for.
 */
export function deriveRefinementMap(fromCut: Cut, toCut: Cut, space: GraphSpace): RefinementMap {
  const index = buildForestIndex(space);
  const fromSet: ReadonlySet<NodeId> = new Set(fromCut.members);
  const toSet: ReadonlySet<NodeId> = new Set(toCut.members);

  const move: NodeId[] = [];
  const enter: EnterEntry[] = [];
  const exit: ExitEntry[] = [];

  for (const id of toCut.members) {
    if (fromSet.has(id)) {
      move.push(id);
      continue;
    }
    const ancestor = nearestAncestorInSet(index, id, fromSet);
    if (ancestor !== undefined) {
      enter.push({ id, sourceKind: 'ancestor', source: ancestor });
      continue;
    }
    const descendants = descendantsInSet(index, id, fromSet);
    if (descendants.length > 0) {
      enter.push({ id, sourceKind: 'descendants', sourceDescendants: descendants });
    } else {
      enter.push({ id, sourceKind: 'none' });
    }
  }

  for (const id of fromCut.members) {
    if (toSet.has(id)) continue; // already recorded as a move
    const ancestor = nearestAncestorInSet(index, id, toSet);
    if (ancestor !== undefined) {
      exit.push({ id, targetKind: 'ancestor', target: ancestor });
      continue;
    }
    const descendants = descendantsInSet(index, id, toSet);
    if (descendants.length > 0) {
      exit.push({ id, targetKind: 'descendants', targetDescendants: descendants });
    } else {
      exit.push({ id, targetKind: 'none' });
    }
  }

  return { move, enter, exit };
}
