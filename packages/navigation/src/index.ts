/**
 * @meridian/navigation — Phase 6's pure semantic-zoom navigation planners.
 * Subphase 6B ships the headless, deterministic core: the `RefinementMap`
 * cut-diff derivation, the `TransitionChoreographer` (ADR-0023) that turns a
 * cut change into an inspectable `TransitionPlan`, its degrade-to-crossfade
 * rule, and the anchor-preservation math (ADR-0024). The NavigationController,
 * hysteresis wiring, drill-in stack, URL codec, and any animation player are
 * 6C/6D and deliberately absent here.
 *
 * Subphase 6C adds the `NavigationController` (ROADMAP §5): the zoom scalar ↔
 * `LodRequest` coupling with the hysteresis state machine (the controller holds
 * `prevLevel`; the resolver stays pure, ADR-0012), the expand/collapse override
 * map, the drill-in/out context stack with derived breadcrumbs (ADR-0025), the
 * URL state codec, search + fly-to over the P1 label-token index, and the pure
 * keyboard command-mapping model. The animation player, minimap, and any
 * Studio/React wiring are 6D and deliberately absent.
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
  FRAME_MARGIN,
  KEY_ZOOM_FACTOR,
  MAX_ANIMATED_NODES,
  MAX_TRANSITION_MS,
  OVERZOOM_MAX,
  READABLE_LEAF_PX,
  SOURCELESS_MAJORITY,
  STABILITY_DEGRADE_FLOOR,
  URL_MAX,
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

// ---------------------------------------------------------------- 6C surface

export {
  assertValidScaleRange,
  cameraScaleLimits,
  deriveScaleRange,
  scaleForZ,
  zForScale,
} from './coupling.js';
export type { ScaleRange } from './coupling.js';

export { containingNode, subSpaceRootedAt } from './subspace.js';

export { buildLabelTokenIndex, searchLabels, tokenize } from './search.js';
export type { LabelTokenIndex, SearchHit } from './search.js';

export { keyToNavCommand, navKeyBindings } from './keyboard.js';
export type { NavCommand, NavVerb } from './keyboard.js';

export { decodeNavUrl, encodeNavUrl } from './url.js';
export type { DecodedNavUrl, EncodedNavUrl, NavUrlState } from './url.js';

export { NavigationController } from './controller.js';
export type {
  Breadcrumb,
  NavContext,
  NavEvent,
  NavigationControllerOptions,
  NavListener,
  NavNotice,
  Unsubscribe,
} from './controller.js';
