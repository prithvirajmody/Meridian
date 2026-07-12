/**
 * Pure world-space geometry for anchoring (ADR-0024) and transition spawn
 * rects (ADR-0023). No wall clock, no renderer state (I6) — every function is a
 * deterministic map over `Rect`/`Point` values from `@meridian/view-model`.
 */
import type { CameraState, Point, Rect, ViewportSize } from '@meridian/view-model';

/** Center of a `Rect` (ADR-0015: `(x + w/2, y + h/2)`). */
export function rectCenter(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** Inclusive containment: is world point `p` inside `Rect` `r`? A degenerate
 * (zero-extent) rect contains only its exact boundary. */
export function rectContains(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

/** Squared Euclidean distance from `p` to the nearest point of `Rect` `r`
 * (`0` when inside). Squared to avoid a `sqrt` in nearest-node scans. */
export function distanceToRectSq(r: Rect, p: Point): number {
  const dx = p.x < r.x ? r.x - p.x : p.x > r.x + r.width ? p.x - (r.x + r.width) : 0;
  const dy = p.y < r.y ? r.y - p.y : p.y > r.y + r.height ? p.y - (r.y + r.height) : 0;
  return dx * dx + dy * dy;
}

/** The tight AABB enclosing every rect, or `undefined` for an empty input. */
export function boundingRect(rects: Iterable<Rect>): Rect | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let saw = false;
  for (const r of rects) {
    saw = true;
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.width > maxX) maxX = r.x + r.width;
    if (r.y + r.height > maxY) maxY = r.y + r.height;
  }
  if (!saw) return undefined;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * The anchor map (ADR-0024): express world point `w` in the normalized
 * coordinates of `rOut` and re-emit it at the same normalized coordinates of
 * `rIn`:
 *
 * ```
 * anchorMap(w, rOut, rIn) = rIn.origin + (w − rOut.origin) ⊙ (rIn.size / rOut.size)
 * ```
 *
 * A degenerate `rOut` extent (zero width/height) maps to `rIn`'s center on that
 * axis. For any `w` inside `rOut`, the result lies inside `rIn`; composing
 * `anchorMap(·, rOut, rIn)` with `anchorMap(·, rIn, rOut)` is the identity up to
 * the rect-to-rect affine (both non-degenerate).
 */
export function anchorMap(w: Point, rOut: Rect, rIn: Rect): Point {
  const nx = rOut.width === 0 ? 0.5 : (w.x - rOut.x) / rOut.width;
  const ny = rOut.height === 0 ? 0.5 : (w.y - rOut.y) / rOut.height;
  return { x: rIn.x + nx * rIn.width, y: rIn.y + ny * rIn.height };
}

/**
 * Map a whole `Rect` from `srcSpace`'s normalized frame into `dstSpace` — the
 * rect analogue of {@link anchorMap}, used to nest a child's final rect into
 * its parent's spawn rect (ADR-0023 enter geometry) and to collapse an exiting
 * node into its ancestor's rect (exit geometry). A degenerate `srcSpace` axis
 * collapses the mapped extent to `0` and pins the origin to `dstSpace`'s center
 * on that axis (consistent with {@link anchorMap}).
 */
export function affineRectMap(rect: Rect, srcSpace: Rect, dstSpace: Rect): Rect {
  const origin = anchorMap({ x: rect.x, y: rect.y }, srcSpace, dstSpace);
  const sx = srcSpace.width === 0 ? 0 : dstSpace.width / srcSpace.width;
  const sy = srcSpace.height === 0 ? 0 : dstSpace.height / srcSpace.height;
  return { x: origin.x, y: origin.y, width: rect.width * sx, height: rect.height * sy };
}

/**
 * The closed-form camera-center solve (ADR-0024): given the anchored world
 * point `worldIn = anchorMap(W, …)`, the screen anchor `A`, the viewport, and
 * the gesture-produced incoming scale `sIn`, return the camera center so that
 * `worldToScreen(worldIn, {center, scale: sIn}, viewport) === A` exactly:
 *
 * ```
 * center = worldIn − (A − viewport/2) / sIn
 * ```
 *
 * One equation, one unknown — no fitting, no search. The anchor rule never
 * alters scale (ADR-0024/0025): `sIn` is passed through untouched.
 */
export function solveCameraCenter(
  worldIn: Point,
  anchorScreen: Point,
  viewport: ViewportSize,
  scaleIn: number,
): Point {
  return {
    x: worldIn.x - (anchorScreen.x - viewport.width / 2) / scaleIn,
    y: worldIn.y - (anchorScreen.y - viewport.height / 2) / scaleIn,
  };
}

/** Convenience: the full incoming {@link CameraState} from the solve. */
export function solveCamera(
  worldIn: Point,
  anchorScreen: Point,
  viewport: ViewportSize,
  scaleIn: number,
): CameraState {
  return { center: solveCameraCenter(worldIn, anchorScreen, viewport, scaleIn), scale: scaleIn };
}
