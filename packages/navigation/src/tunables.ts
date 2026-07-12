/**
 * The 6E tunable-constants surface (ADR-0023/0024/0025 "6E panel"). One
 * canonical defaults object, `NAV_TUNABLE_DEFAULTS`, frozen from the named
 * constants in `constants.ts` — the single source the Studio debug panel's
 * session copy is initialized from and reset to. The shipped defaults are the
 * ADR values; the panel edits a session copy only, and every pure function
 * here accepts the relevant slice as an explicit parameter (I6 — tuning is
 * data flowing through pure calls, never hidden mutable module state).
 *
 * Not tunable and deliberately absent: `MAX_TRANSITION_MS` (a constitutional
 * budget, §16.1), `URL_MAX` (a wire cap, not feel), and `EASING` (one shared
 * curve is the ADR-0023 decision — the panel displays it view-only).
 */
import {
  ANCHOR_SNAP_FACTOR,
  BASE_TRANSITION_MS,
  CROSSFADE_MS,
  FRAME_MARGIN,
  KEY_ZOOM_FACTOR,
  MAX_ANIMATED_NODES,
  OVERZOOM_MAX,
  READABLE_LEAF_PX,
  SOURCELESS_MAJORITY,
  STABILITY_DEGRADE_FLOOR,
} from './constants.js';

/** Every 6E-tunable navigation constant, as a value bag (ADR-0023 §"Future
 * implications", ADR-0024 §"Future implications", ADR-0025 §"Future
 * implications"). */
export interface NavTunables {
  /** Choreographed transition duration, ms (ADR-0023 `BASE_TRANSITION_MS`).
   * Clamped to `MAX_TRANSITION_MS` at plan time — the §16.1 budget is not
   * tunable. */
  readonly baseTransitionMs: number;
  /** Degraded cross-fade duration, ms (ADR-0023 `CROSSFADE_MS`). */
  readonly crossfadeMs: number;
  /** Degrade trigger 1: animated-node budget (ADR-0023 `MAX_ANIMATED_NODES`). */
  readonly maxAnimatedNodes: number;
  /** Degrade trigger 3: stability floor (ADR-0023, `stabilityScore < floor`). */
  readonly stabilityDegradeFloor: number;
  /** Degrade trigger 2: sourceless/targetless majority fraction (ADR-0023). */
  readonly sourcelessMajority: number;
  /** Empty-space anchor snap radius as a multiple of Λ (ADR-0024
   * `ANCHOR_SNAP = factor·Λ`). */
  readonly anchorSnapFactor: number;
  /** Geometric overzoom slack past the scale range (ADR-0025 `OVERZOOM_MAX`). */
  readonly overzoomMax: number;
  /** Fit-margin fraction when framing a context (ADR-0025 `FRAME_MARGIN`). */
  readonly frameMargin: number;
  /** Per-keypress zoom factor for `+`/`−` (ADR-0025 trigger table). */
  readonly keyZoomFactor: number;
  /** Readable on-screen leaf size, CSS px — the `s_max` end of the scale-range
   * derivation (ADR-0025 `READABLE_LEAF_PX`). */
  readonly readableLeafPx: number;
}

/** The slice `planTransition` consumes (ADR-0023 constants). */
export type TransitionTunables = Pick<
  NavTunables,
  | 'baseTransitionMs'
  | 'crossfadeMs'
  | 'maxAnimatedNodes'
  | 'stabilityDegradeFloor'
  | 'sourcelessMajority'
>;

/** The slice the `NavigationController` consumes live (ADR-0025 constants). */
export type ControllerTunables = Pick<NavTunables, 'overzoomMax' | 'keyZoomFactor'>;

/**
 * The canonical frozen defaults — exactly the ADR-ruled constants from
 * `constants.ts` (the 6A review accepted them as initial mechanism values;
 * re-tuning at the M2 human gate edits the ADRs/constants, never this file
 * independently — it has no literals of its own on purpose).
 */
export const NAV_TUNABLE_DEFAULTS: NavTunables = Object.freeze({
  baseTransitionMs: BASE_TRANSITION_MS,
  crossfadeMs: CROSSFADE_MS,
  maxAnimatedNodes: MAX_ANIMATED_NODES,
  stabilityDegradeFloor: STABILITY_DEGRADE_FLOOR,
  sourcelessMajority: SOURCELESS_MAJORITY,
  anchorSnapFactor: ANCHOR_SNAP_FACTOR,
  overzoomMax: OVERZOOM_MAX,
  frameMargin: FRAME_MARGIN,
  keyZoomFactor: KEY_ZOOM_FACTOR,
  readableLeafPx: READABLE_LEAF_PX,
});
