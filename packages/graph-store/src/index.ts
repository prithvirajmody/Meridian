export { decodeDelta, decodeDeltaInput, deltaToWire } from './decode.js';
export type { DecodeCompleteDeltaResult, DecodeDeltaResult } from './decode.js';
export { diffSpaces } from './diff.js';
export {
  DEFAULT_LOW_WATER_RATIO,
  DEFAULT_MAX_RESIDENT_ELEMENTS,
  HYDRATION_ACTOR,
  HydrationManager,
} from './hydration.js';
export type {
  GraphManifestEntry,
  HydrationManagerOptions,
  HydrationPolicy,
  HydrationState,
  HydrationStats,
} from './hydration.js';
export { tokenizeLabel } from './indices.js';
export type { StoreIssue, StoreIssueCode } from './issues.js';
export { composeDeltas, invertDelta, invertOp } from './ops.js';
export type {
  GraphDelta,
  GraphDeltaInput,
  GraphOp,
  GraphOpInput,
  OpOrigin,
  PortableDelta,
} from './ops.js';
export type { GraphQuery, NeighborConstraint } from './query.js';
export { applyDelta, createStore } from './store.js';
export type {
  ApplyResult,
  ChangeListener,
  ChangeSet,
  CreateStoreOptions,
  GraphStore,
  StorageBackend,
  Unsubscribe,
} from './store.js';
export type { GraphTransaction, TxEdgeInit, TxGraphInit, TxNodeInit } from './transaction.js';
export { stageDeltaStream } from './stream.js';
export type {
  StageDeltaStreamFailure,
  StageDeltaStreamFailureCode,
  StageDeltaStreamOptions,
  StageDeltaStreamProgress,
  StageDeltaStreamResult,
  StageDeltaStreamStats,
} from './stream.js';
export {
  compareVersions,
  formatVersion,
  initialVersion,
  LOCAL_SITE,
  successorVersion,
  versionsEqual,
} from './version.js';
export type { VersionStamp } from './version.js';
