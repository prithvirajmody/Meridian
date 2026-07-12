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

// --------------------------------------------------------------- 6C: nav/zoom

/** Geometric overzoom slack past the scale range in either direction
 * (ADR-0025 `OVERZOOM_MAX = 4×`): at `z = 1` the camera may keep zooming in to
 * `s_max · OVERZOOM_MAX`, and symmetrically out to `s_min / OVERZOOM_MAX` at
 * `z = 0`, while the cut stops changing and scope never changes. */
export const OVERZOOM_MAX = 4;

/** Fit-margin fraction when a context frames its world bounds on drill-in
 * (ADR-0025 `FRAME_MARGIN = 10%`). Consumed by the scale-range derivation. */
export const FRAME_MARGIN = 0.1;

/** Per-keypress zoom factor for the `+`/`−` keys (ADR-0025 trigger table). A
 * navigation constant frozen here as mechanism; re-tuned at the 6E gate. */
export const KEY_ZOOM_FACTOR = 1.25;

/** Hard cap on a serialized navigation fragment (ADR-0025 `URL_MAX = 2000`):
 * beyond it the override list `ov` is truncated with a visible diagnostic so
 * the link stays shareable and honest. */
export const URL_MAX = 2000;

/** Default readable on-screen size (CSS px) of a "typical leaf" — the `s_max`
 * end of the scale range (ADR-0025 "typical leaf at readable size"). Tunable
 * at the 6E gate; overridable per call in {@link
 * import('./coupling.js').deriveScaleRange}. */
export const READABLE_LEAF_PX = 120;
