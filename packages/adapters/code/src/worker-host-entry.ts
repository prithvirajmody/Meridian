/**
 * Main-thread-safe production composition surface. This entry deliberately
 * has no edge to the tree-sitter shim; browser and Node applications can own
 * a parse worker without bundling parser runtime code into their main thread.
 */
export { CODE_PROJECT_MEDIA_TYPE } from './bundle.js';
export { createCodePlugin } from './plugin.js';
export { createWorkerMapper } from './worker-mapper.js';
export type { CodeMapper } from './mapper.js';
export { ParseWorkerHost } from './worker/host.js';
export type {
  CancelledMessage,
  CancelMessage,
} from './worker/protocol.js';
export type {
  CrashInfo,
  WorkerFactory,
  WorkerHandle,
} from './worker/host.js';
