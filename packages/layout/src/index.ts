/**
 * @meridian/layout — the layout engine (ROADMAP Phase 4). Subphase 4B ships
 * the `LayoutProvider` contract, the world-space geometry types (ADR-0015),
 * the deterministic `grid`/`tree` providers (MAIN-THREAD, no worker yet), the
 * pure `stabilityScore` (ADR-0016), and a DOM-free SVG snapshot exporter so
 * layout quality is reviewable without a renderer. Workers/cancellation/cache
 * (4C), elk-layered (4D), and d3-force + the default-provider heuristic (4E)
 * follow.
 *
 * Dependency law (ADR-0015 ruling, binding for Phase 4): layout imports **only**
 * `@meridian/abstraction` (`Cut`/`InducedEdge`) and `@meridian/graph-core` (id
 * brands). No DOM, no domain words, no AI — a core-law package. The transient
 * `layout → abstraction` edge is a documented, time-boxed waypoint that
 * subphase 5B retires by repointing layout to `view-model`.
 */
export type { Point, Rect, Size } from './coords.js';
export type {
  LayoutCapabilities,
  LayoutDirection,
  LayoutHints,
  LayoutInput,
  LayoutProvider,
  LayoutResult,
} from './types.js';
export { boundsOf, centerOf, DEFAULT_SPACING, EMPTY_BOUNDS, packComponents } from './geometry.js';
export type { LaidOutComponent } from './geometry.js';
export { connectedComponents } from './components.js';
export { gridProvider } from './grid.js';
export { treeProvider } from './tree.js';
export { STABILITY_RAMP, stabilityScore } from './stability.js';
export type { StabilityScore } from './stability.js';
export { exportSvg } from './svg.js';
export type { SvgOptions } from './svg.js';

// --- Worker infrastructure (4C; ADR-0017) ----------------------------------
export {
  buildIndexTable,
  decodeRequest,
  decodeResponse,
  decodeResponseLazy,
  encodeRequest,
  encodeResponse,
  placeholderId,
  requestTransfer,
  responseTransfer,
} from './worker/protocol.js';
export type { IndexTable, WireRequest, WireResponse } from './worker/protocol.js';
export { abortError, createLayoutWorker } from './worker/worker-api.js';
export type {
  CancelledMessage,
  CancelMessage,
  LayoutWorkerApi,
  WorkerControlChannel,
} from './worker/worker-api.js';
export { DEFAULT_CRASH_BUDGET, LayoutWorkerHost } from './worker/host.js';
export type {
  CrashBudget,
  CrashInfo,
  HostControlChannel,
  LayoutComputeOptions,
  LayoutHostResult,
  LayoutHostStats,
  LayoutSource,
  LayoutWorkerHostOptions,
  WorkerFactory,
  WorkerHandle,
} from './worker/host.js';
export {
  cacheKeyString,
  DEFAULT_CACHE_CAPACITY,
  fnv1a,
  hashCut,
  hashHints,
  LayoutCache,
} from './worker/cache.js';
export type { LayoutCacheKey } from './worker/cache.js';

import { gridProvider } from './grid.js';
import { treeProvider } from './tree.js';
import type { LayoutProvider } from './types.js';

/** The deterministic providers that ship in 4B, by id. elk-layered (4D) and
 * d3-force (4E) register later. */
export const BUILTIN_LAYOUT_PROVIDERS: ReadonlyMap<string, LayoutProvider> = new Map([
  [gridProvider.id, gridProvider],
  [treeProvider.id, treeProvider],
]);
