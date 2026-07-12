/**
 * Anchor preservation (ADR-0024) — "the Google-Maps rule" as pure functions.
 * The world point under the cursor at a threshold crossing is mapped through
 * the refinement so the same *semantic location* stays under the cursor after
 * the cut swap. This module supplies the three testable pieces the roadmap 6B
 * property suite names: anchor-node selection, the affine rect-to-rect map
 * (in `geometry.ts`), and the closed-form camera-center solve.
 */
import type { CameraState, LayoutResult, Point, Rect, ViewportSize } from '@meridian/view-model';
import type { Cut, NodeId } from '@meridian/view-model';
import { ANCHOR_SNAP_FACTOR } from './constants.js';
import {
  anchorMap,
  boundingRect,
  distanceToRectSq,
  rectContains,
  solveCamera,
} from './geometry.js';
import type { RefinementMap } from './refinement.js';

function compareIds(a: NodeId, b: NodeId): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The chosen anchor node, or empty space (`node === undefined`). */
export interface AnchorSelection {
  /** The anchor node `u`, or `undefined` for empty space (geometric fallback). */
  readonly node: NodeId | undefined;
  /** True when `u` was chosen by the `ANCHOR_SNAP` near-miss rule rather than
   * strict containment. */
  readonly snapped: boolean;
}

/**
 * Select the anchor node `u` for world point `world` in `cut`/`layout`
 * (ADR-0024): the member whose rect **contains** `world`; if several (layout
 * overlap), the **smallest by area**, ties by **ascending `NodeId`**. If none
 * contains it, the nearest rect within `ANCHOR_SNAP = 0.5·Λ` (Euclidean, to the
 * rect boundary) is `u` (`snapped`); otherwise the anchor is empty space.
 *
 * `lambda` is ADR-0016's characteristic length `Λ`, supplied by the caller
 * (`characteristicLength(layout, hints)` from `@meridian/view-model`).
 * `snapFactor` is the 6E-tunable `ANCHOR_SNAP` multiple of `Λ` (defaults to
 * the frozen ADR-0024 value).
 */
export function selectAnchorNode(
  cut: Cut,
  layout: LayoutResult,
  world: Point,
  lambda: number,
  snapFactor: number = ANCHOR_SNAP_FACTOR,
): AnchorSelection {
  let best: NodeId | undefined;
  let bestArea = Infinity;
  for (const id of cut.members) {
    const rect = layout.positions.get(id);
    if (rect === undefined || !rectContains(rect, world)) continue;
    const area = rect.width * rect.height;
    if (area < bestArea || (area === bestArea && (best === undefined || compareIds(id, best) < 0))) {
      best = id;
      bestArea = area;
    }
  }
  if (best !== undefined) return { node: best, snapped: false };

  // No containing rect: snap to the nearest boundary within ANCHOR_SNAP.
  const snapRadius = snapFactor * lambda;
  const snapRadiusSq = snapRadius * snapRadius;
  let nearest: NodeId | undefined;
  let nearestSq = Infinity;
  for (const id of cut.members) {
    const rect = layout.positions.get(id);
    if (rect === undefined) continue;
    const dSq = distanceToRectSq(rect, world);
    if (dSq < nearestSq || (dSq === nearestSq && (nearest === undefined || compareIds(id, nearest) < 0))) {
      nearest = id;
      nearestSq = dSq;
    }
  }
  if (nearest !== undefined && nearestSq <= snapRadiusSq) return { node: nearest, snapped: true };
  return { node: undefined, snapped: false };
}

/**
 * `R_in` for anchor node `u` (ADR-0024): the bbox of `u`'s refinement image in
 * the incoming layout — its covering ancestor's rect (zoom-out), the bbox of
 * its entering descendants (zoom-in), or its own incoming rect (`u` persists —
 * a move). `undefined` when `u` has no image (targetless exit) — the caller
 * then takes the geometric fallback `W' = W`.
 */
export function refinementImageRect(
  u: NodeId,
  refinement: RefinementMap,
  toLayout: LayoutResult,
): Rect | undefined {
  // u persists as a move → its own incoming rect.
  if (refinement.move.includes(u)) return toLayout.positions.get(u);

  const exit = refinement.exit.find((e) => e.id === u);
  if (exit === undefined) return undefined; // u is not in the outgoing cut's diff
  if (exit.targetKind === 'ancestor' && exit.target !== undefined) {
    return toLayout.positions.get(exit.target);
  }
  if (exit.targetKind === 'descendants' && exit.targetDescendants !== undefined) {
    const rects: Rect[] = [];
    for (const d of exit.targetDescendants) {
      const r = toLayout.positions.get(d);
      if (r !== undefined) rects.push(r);
    }
    return boundingRect(rects);
  }
  return undefined; // targetless
}

/** The full anchor solve for one continuous-zoom threshold crossing. */
export interface AnchorSolution {
  /** `'refinement'` when the point was mapped through `u`'s image; `'geometric'`
   * when it fell back to `W' = W` (empty space or no image). */
  readonly mode: 'refinement' | 'geometric';
  /** The anchor node, when one was selected. */
  readonly anchorNode?: NodeId;
  /** The anchored world point in the outgoing frame (`W`). */
  readonly worldOut: Point;
  /** The mapped world point in the incoming frame (`W'`). */
  readonly worldIn: Point;
  /** The solved incoming camera (`scale` passed through untouched). */
  readonly camera: CameraState;
  /** A located reason when a fallback was taken (never throws). */
  readonly fallback?: 'empty-space' | 'no-image';
}

/**
 * Solve the anchored incoming camera for a threshold crossing (ADR-0024). Pure:
 * select `u`, map `W` through `u`'s refinement image to `W'`, and solve the
 * closed-form center so `W'` lands on the same screen point `anchorScreen` at
 * the gesture-produced `scaleIn`. Empty space or a `u` with no incoming image
 * fall back to geometric anchoring (`W' = W`) with a located reason — the
 * anchor never throws.
 */
export function solveAnchoredCamera(args: {
  readonly worldOut: Point;
  readonly anchorScreen: Point;
  readonly viewport: ViewportSize;
  readonly scaleIn: number;
  readonly fromCut: Cut;
  readonly fromLayout: LayoutResult;
  readonly toLayout: LayoutResult;
  readonly refinement: RefinementMap;
  readonly lambda: number;
  /** 6E-tunable `ANCHOR_SNAP` multiple of `Λ` (default: frozen ADR-0024 value). */
  readonly anchorSnapFactor?: number;
}): AnchorSolution {
  const { worldOut, anchorScreen, viewport, scaleIn, fromCut, fromLayout, toLayout, refinement, lambda } = args;

  const geometric = (fallback: 'empty-space' | 'no-image', anchorNode?: NodeId): AnchorSolution => ({
    mode: 'geometric',
    ...(anchorNode !== undefined ? { anchorNode } : {}),
    worldOut,
    worldIn: worldOut,
    camera: solveCamera(worldOut, anchorScreen, viewport, scaleIn),
    fallback,
  });

  const selection = selectAnchorNode(fromCut, fromLayout, worldOut, lambda, args.anchorSnapFactor);
  if (selection.node === undefined) return geometric('empty-space');

  const rOut = fromLayout.positions.get(selection.node);
  const rIn = refinementImageRect(selection.node, refinement, toLayout);
  if (rOut === undefined || rIn === undefined) return geometric('no-image', selection.node);

  const worldIn = anchorMap(worldOut, rOut, rIn);
  return {
    mode: 'refinement',
    anchorNode: selection.node,
    worldOut,
    worldIn,
    camera: solveCamera(worldIn, anchorScreen, viewport, scaleIn),
  };
}
