/** Browser module-worker entry. The factory resolves this emitted sibling by URL. */
import { attachSpatialIndexWorker, type SpatialIndexWorkerScope } from './worker.js';

attachSpatialIndexWorker(globalThis as unknown as SpatialIndexWorkerScope);
