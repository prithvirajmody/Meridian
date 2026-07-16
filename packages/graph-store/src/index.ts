export { decodeDelta, decodeDeltaInput, deltaToWire } from './decode.js';
export type { DecodeCompleteDeltaResult, DecodeDeltaResult } from './decode.js';
export { diffSpaces } from './diff.js';
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
export {
  compareVersions,
  formatVersion,
  initialVersion,
  LOCAL_SITE,
  successorVersion,
  versionsEqual,
} from './version.js';
export type { VersionStamp } from './version.js';
