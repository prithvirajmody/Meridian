/**
 * Named transition/anchor constants (ADR-0023, ADR-0024). Every one is frozen
 * here as *mechanism* and re-tuned at the 6E human gate — the ADR-0012 pattern.
 * They are exported so the 6E debug panel can surface them as tunables.
 */

/** Choreographed transition duration in ms (ADR-0023 `BASE_TRANSITION_MS`). */
export const BASE_TRANSITION_MS = 240;

/** Hard plan-to-settle budget in ms (ARCHITECTURE §16.1; ADR-0023
 * `MAX_TRANSITION_MS`). Plan computation + animation must fit inside this. */
export const MAX_TRANSITION_MS = 300;

/** Cross-fade duration in ms when a transition degrades (ADR-0023
 * `CROSSFADE_MS`). */
export const CROSSFADE_MS = 160;

/** Degrade trigger 1: `|enter| + |exit| + |displaced moves|` above this count
 * is the predicted-cost proxy for "cannot hold 45fps" (ADR-0023
 * `MAX_ANIMATED_NODES`). */
export const MAX_ANIMATED_NODES = 1500;

/** Degrade trigger 3: `stabilityScore(from.layout, to.layout) < 0.5` means move
 * targets are teleports — tweening them looks worse than a fade (ADR-0023). */
export const STABILITY_DEGRADE_FLOOR = 0.5;

/** Degrade trigger 2: more than this fraction of enter+exit nodes being
 * sourceless/targetless means there is no spawn geometry to choreograph
 * (ADR-0023, "more than 50%"). */
export const SOURCELESS_MAJORITY = 0.5;

/** Empty-space snap radius as a multiple of `Λ` (ADR-0024 `ANCHOR_SNAP =
 * 0.5·Λ`): a near-miss within this distance of a rect still tracks that node. */
export const ANCHOR_SNAP_FACTOR = 0.5;

/** The one shared easing for every animated property — rects, alpha, and the
 * camera path (ADR-0023). A named constant so the 6E panel can display it;
 * sampling the curve is the renderer-side player's job, not this package's. */
export const EASING = 'easeInOutCubic' as const;
