/** ADR-0020's pure, DPR-independent geometric label policy. */
import type { CameraState } from './camera.js';
import type { Rect } from './coords.js';

export const LABEL_CLASS_FORCED = 0;
export const LABEL_CLASS_SUMMARY = 1;
export const LABEL_CLASS_CONNECTED = 2;
export const LABEL_CLASS_ORDINARY = 3;

export type LabelClass =
  | typeof LABEL_CLASS_FORCED
  | typeof LABEL_CLASS_SUMMARY
  | typeof LABEL_CLASS_CONNECTED
  | typeof LABEL_CLASS_ORDINARY;

export const LABEL_SUMMARY_THRESHOLD_CSS_PX = 8;
export const LABEL_CONNECTED_THRESHOLD_CSS_PX = 16;
export const LABEL_ALL_THRESHOLD_CSS_PX = 28;

/**
 * Maximum eligible label class at a projected node height. Exact lower bounds
 * enter the next tier: 8 → summary, 16 → connected, 28 → ordinary.
 */
export function labelTier(projectedNodeHeightCssPx: number): LabelClass {
  const height =
    Number.isFinite(projectedNodeHeightCssPx) && projectedNodeHeightCssPx > 0
      ? projectedNodeHeightCssPx
      : 0;
  if (height < LABEL_SUMMARY_THRESHOLD_CSS_PX) return LABEL_CLASS_FORCED;
  if (height < LABEL_CONNECTED_THRESHOLD_CSS_PX) return LABEL_CLASS_SUMMARY;
  if (height < LABEL_ALL_THRESHOLD_CSS_PX) return LABEL_CLASS_CONNECTED;
  return LABEL_CLASS_ORDINARY;
}

/** Project a world-space node height into CSS pixels for {@link labelTier}. */
export function projectedNodeHeight(rect: Rect, camera: CameraState): number {
  if (!Number.isFinite(rect.height) || rect.height <= 0) return 0;
  if (!Number.isFinite(camera.scale) || camera.scale <= 0) return 0;
  return rect.height * camera.scale;
}

export function isLabelEligible(labelClass: LabelClass, activeTier: LabelClass): boolean {
  return labelClass <= activeTier;
}
