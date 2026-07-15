/** @meridian/projections — projection contracts and headless built-ins. */
export type {
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
export { OUTLINE_PROJECTION, OutlineProjection } from './outline.js';
export { ProjectionRegistry } from './registry.js';
export type { RankedProjection } from './registry.js';
