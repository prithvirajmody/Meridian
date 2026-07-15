/**
 * @meridian/view-model — Phase 5's pure, serializable presentation waist.
 * The renderer consumes `RenderModel`; layout consumes the shared geometry/I/O
 * types. No DOM, GPU, React, store, or I/O dependency exists here.
 */
export type {
  Cut,
  CutMember,
  CutReason,
  InducedEdge,
  LodResult,
} from '@meridian/abstraction';
export type {
  AttrBag,
  AttrValue,
  EdgeId,
  GraphId,
  GraphSpace,
  NodeId,
  SemanticEdge,
  SemanticGraph,
  SemanticNode,
  SourceRef,
} from '@meridian/graph-core';

export type { Point, Rect, Size } from './coords.js';
export type {
  CompoundNesting,
  LayoutCapabilities,
  LayoutDirection,
  LayoutHints,
  LayoutInput,
  LayoutProvider,
  LayoutResult,
} from './layout-types.js';

export {
  createCameraState,
  DEFAULT_CAMERA_SCALE_LIMITS,
  panBy,
  screenToWorld,
  worldToScreen,
  zoomAt,
} from './camera.js';
export type { CameraScaleLimits, CameraState, ViewportSize } from './camera.js';

export { createFocusState, EMPTY_FOCUS } from './focus.js';
export type { FocusState } from './focus.js';

export {
  isLabelEligible,
  LABEL_ALL_THRESHOLD_CSS_PX,
  LABEL_CLASS_CONNECTED,
  LABEL_CLASS_FORCED,
  LABEL_CLASS_ORDINARY,
  LABEL_CLASS_SUMMARY,
  LABEL_CONNECTED_THRESHOLD_CSS_PX,
  LABEL_SUMMARY_THRESHOLD_CSS_PX,
  labelTier,
  projectedNodeHeight,
} from './labels.js';
export type { LabelClass } from './labels.js';

export {
  characteristicLength,
  STABILITY_EPSILON,
  STABILITY_RAMP,
  stabilityScore,
} from './stability.js';
export type { StabilityScore } from './stability.js';

export {
  buildRenderModel,
  EDGE_FLAG_SELECTED,
  EDGE_FLAG_SELECTION_ANCHOR,
  EMPTY_SELECTION,
  NODE_FLAG_HAS_DETAIL,
  NODE_FLAG_SELECTED,
  NODE_FLAG_SELECTION_ANCHOR,
} from './render-model.js';
export type {
  RenderDiagnostic,
  RenderDiagnosticCode,
  RenderModel,
  Selection,
  SelectionAnchor,
  SelectionState,
} from './render-model.js';

export { buildProjectionModel } from './projection-model.js';
export type {
  BuildProjectionModelOptions,
  DomainMeta,
  ProjectionModel,
  ProjectionNode,
  TemporalDomainHints,
} from './projection-model.js';
