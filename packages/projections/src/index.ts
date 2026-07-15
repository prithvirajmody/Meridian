/** @meridian/projections — projection contracts and headless built-ins. */
export type {
  Canvas2dFrame,
  Canvas2dInput,
  Canvas2dLabel,
  Canvas2dLine,
  Canvas2dMedium,
  Canvas2dPointerAction,
  Canvas2dRect,
  Canvas2dSurface,
  NodeLinkMedium,
  NodeLinkSurface,
  ProjectionDiagnostic,
  ProjectionHost,
  ProjectionInstance,
  ProjectionLifecyclePhase,
  ProjectionNavigationIntent,
  ProjectionViewState,
  ProjectionViewport,
  VirtualListFrame,
  VirtualListInput,
  VirtualListKey,
  VirtualListMedium,
  VirtualListRow,
  VirtualListSurface,
  ViewProjection,
} from './contracts.js';

export { MAP_PROJECTION, MapProjection } from './map.js';
export {
  MATRIX_GUTTER_LEFT_PX,
  MATRIX_GUTTER_TOP_PX,
  MATRIX_LABEL_MIN_CELL_PX,
  MATRIX_MAX_CELL_PX,
  MATRIX_MIN_CELL_PX,
  MATRIX_PROJECTION,
  MatrixProjection,
  orderMatrixNodes,
} from './matrix.js';
export type { MatrixCluster, MatrixOrdering } from './matrix.js';
export { OUTLINE_PROJECTION, OutlineProjection } from './outline.js';
export {
  TIMELINE_AXIS_HEIGHT_PX,
  TIMELINE_GUTTER_LEFT_PX,
  TIMELINE_LANE_MAX_PX,
  TIMELINE_LANE_MIN_PX,
  TIMELINE_PROJECTION,
  TimelineProjection,
  timelineEvents,
  timelineTickLabel,
} from './timeline.js';
export { ProjectionRegistry } from './registry.js';
export type { RankedProjection } from './registry.js';
