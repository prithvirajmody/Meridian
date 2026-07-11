/** Minimal ADR-0021 integration surface. */
export { createBrowserSpatialIndexWorkerFactory } from './browser-worker-factory.js';
export type {
  BrowserSpatialIndexWorker,
  BrowserSpatialIndexWorkerFactoryOptions,
} from './browser-worker-factory.js';
export { SpatialIndexHost } from './host.js';
export type {
  SpatialIndexBuildInput,
  SpatialIndexBuildOptions,
  SpatialIndexHostOptions,
  SpatialIndexHostStats,
  SpatialIndexSnapshot,
  SpatialIndexWorkerEndpoint,
  SpatialIndexWorkerFactory,
} from './host.js';
