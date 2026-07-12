/**
 * @meridian/navigation — Phase 6's pure semantic-zoom navigation planners.
 * Subphase 6B ships the headless, deterministic core: the `RefinementMap`
 * cut-diff derivation, the `TransitionChoreographer` (ADR-0023) that turns a
 * cut change into an inspectable `TransitionPlan`, its degrade-to-crossfade
 * rule, and the anchor-preservation math (ADR-0024). The NavigationController,
 * hysteresis wiring, drill-in stack, URL codec, and any animation player are
 * 6C/6D and deliberately absent here.
 *
 * Dependency law (§20): imports `@meridian/abstraction` and
 * `@meridian/view-model` only — no layout, renderer, DOM, store, or I/O edge.
 * Nothing reads wall time or randomness (I6).
 */
export {
  ANCHOR_SNAP_FACTOR,
  BASE_TRANSITION_MS,
  CROSSFADE_MS,
  EASING,
  MAX_ANIMATED_NODES,
  MAX_TRANSITION_MS,
  SOURCELESS_MAJORITY,
  STABILITY_DEGRADE_FLOOR,
} from './constants.js';

export {
  affineRectMap,
  anchorMap,
  boundingRect,
  distanceToRectSq,
  rectCenter,
  rectContains,
  solveCamera,
  solveCameraCenter,
} from './geometry.js';

export { deriveRefinementMap } from './refinement.js';
export type {
  CorrespondenceKind,
  EnterEntry,
  ExitEntry,
  RefinementMap,
} from './refinement.js';

export {
  refinementImageRect,
  selectAnchorNode,
  solveAnchoredCamera,
} from './anchor.js';
export type { AnchorSelection, AnchorSolution } from './anchor.js';

export { planTransition, TransitionChoreographer } from './choreographer.js';
export type {
  DegradeTrigger,
  NodeAnim,
  PlanDiagnostic,
  TransitionFrame,
  TransitionMode,
  TransitionPlan,
} from './choreographer.js';
