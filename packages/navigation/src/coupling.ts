/**
 * Scale ↔ zoom-scalar coupling (ADR-0025). The controller owns a single
 * **log-linear** map between camera scale `s` (CSS px per world unit,
 * `@meridian/view-model`) and the zoom scalar `z ∈ [0,1]` the LOD resolver
 * consumes (ADR-0012). One map, two directions — the scalar is never a second,
 * independently-drifting state:
 *
 * ```
 * z = clamp((log s − log s_min) / (log s_max − log s_min), 0, 1)
 * s = exp(log s_min + z · (log s_max − log s_min))          // the inverse
 * ```
 *
 * `[s_min, s_max]` is a per-context `ScaleRange`: `s_min` is "fit all" and
 * `s_max` is "a typical leaf at a readable size", both derived from the
 * context's world bounds and viewport (`deriveScaleRange`). Wheel/pinch drive
 * *scale* (clamped with `OVERZOOM_MAX` slack, `clampCameraScale`); `z` is then
 * derived and clamped to `[0,1]`, so geometric overzoom past the range never
 * moves the cut (saturation, ADR-0025). `scaleForZ` inverts the map for
 * `zoomTo(z, …)`.
 *
 * Pure and deterministic (I6): only `Math.log`/`Math.exp`, no wall clock, no
 * randomness.
 */
import type { Rect, ViewportSize } from '@meridian/view-model';
import { FRAME_MARGIN, OVERZOOM_MAX, READABLE_LEAF_PX } from './constants.js';

/** A context's log-linear scale window: `sMin` = fit-all, `sMax` = readable
 * leaf (ADR-0025). `0 < sMin ≤ sMax`. */
export interface ScaleRange {
  readonly sMin: number;
  readonly sMax: number;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Validate a scale range is finite with `0 < sMin ≤ sMax`; located throw on a
 * malformed range (a programming/config error, not data). */
export function assertValidScaleRange(range: ScaleRange): void {
  const { sMin, sMax } = range;
  if (!(sMin > 0) || !Number.isFinite(sMin) || !(sMax > 0) || !Number.isFinite(sMax)) {
    throw new RangeError(`ScaleRange: sMin/sMax must be finite and > 0, got ${sMin}/${sMax}`);
  }
  if (sMax < sMin) throw new RangeError(`ScaleRange: sMax (${sMax}) must be ≥ sMin (${sMin})`);
}

/** The zoom scalar `z ∈ [0,1]` for a camera scale `s` (ADR-0025). A degenerate
 * range (`sMin === sMax`) has no interior, so any scale maps to `z = 1`
 * (finest). Scales outside `[sMin, sMax]` clamp to `0`/`1` — geometric overzoom
 * does not move the cut. */
export function zForScale(s: number, range: ScaleRange): number {
  assertValidScaleRange(range);
  const { sMin, sMax } = range;
  if (sMax === sMin) return 1;
  const z = (Math.log(s) - Math.log(sMin)) / (Math.log(sMax) - Math.log(sMin));
  return clamp(z, 0, 1);
}

/** The camera scale for a zoom scalar `z ∈ [0,1]` (the inverse of
 * {@link zForScale}). `z` is clamped to `[0,1]`; the result lies in
 * `[sMin, sMax]`. */
export function scaleForZ(z: number, range: ScaleRange): number {
  assertValidScaleRange(range);
  const { sMin, sMax } = range;
  const zc = clamp(z, 0, 1);
  if (sMax === sMin) return sMin;
  return Math.exp(Math.log(sMin) + zc * (Math.log(sMax) - Math.log(sMin)));
}

/** The camera scale limits including `OVERZOOM_MAX` geometric slack on both
 * ends (ADR-0025): `[sMin / OVERZOOM_MAX, sMax · OVERZOOM_MAX]`. Feeding these
 * to `zoomAt` lets the camera keep crisping past `z = 1`/`z = 0` while
 * {@link zForScale} pins the scalar — the saturation rule. */
export function cameraScaleLimits(range: ScaleRange, overzoom: number = OVERZOOM_MAX): {
  readonly min: number;
  readonly max: number;
} {
  assertValidScaleRange(range);
  return { min: range.sMin / overzoom, max: range.sMax * overzoom };
}

/**
 * Derive a context's `ScaleRange` from its world bounds and the viewport
 * (ADR-0025): `s_min` fits the whole (margin-padded) bounds into the viewport;
 * `s_max` shows a typical leaf at `readableLeafPx`. Pure; the tunables
 * (`FRAME_MARGIN`, `READABLE_LEAF_PX`, `leafWorldSize`) go to the 6E panel.
 *
 * `leafWorldSize` is the characteristic world extent of a leaf node in this
 * context; callers with real layout pass `Λ` (ADR-0016). It defaults to a
 * fraction of the smaller bounds extent so a range is always derivable
 * headless. An empty/degenerate bounds yields a unit range `[1,1]`.
 *
 * *(6C/6D seam: 6C exercises the coupling against explicit `ScaleRange`s; wiring
 * real world bounds + Λ from layout is 6D. Flagged for ADR-0025 fold-back —
 * the ADR names the derivation but leaves `leafWorldSize` implicit.)*
 */
export function deriveScaleRange(
  worldBounds: Rect,
  viewport: ViewportSize,
  opts: { readonly readableLeafPx?: number; readonly leafWorldSize?: number } = {},
): ScaleRange {
  const readableLeafPx = opts.readableLeafPx ?? READABLE_LEAF_PX;
  const bw = worldBounds.width;
  const bh = worldBounds.height;
  if (!(bw > 0) || !(bh > 0) || !(viewport.width > 0) || !(viewport.height > 0)) {
    return { sMin: 1, sMax: 1 };
  }
  const padded = 1 + 2 * FRAME_MARGIN;
  const sFit = Math.min(viewport.width / (bw * padded), viewport.height / (bh * padded));
  const leafWorldSize = opts.leafWorldSize ?? Math.min(bw, bh) / 20;
  const sLeaf = leafWorldSize > 0 ? readableLeafPx / leafWorldSize : sFit;
  const sMin = sFit;
  const sMax = Math.max(sFit, sLeaf);
  return { sMin, sMax };
}
