export {
  ATTR_KEY_PATTERN,
  attrValueMatchesType,
  CORE_NAMESPACE,
  isValidAttrValue,
  KIND_PATTERN,
  namespaceOf,
  RESERVED_CORE_ATTR_KEYS,
} from './attrs.js';
export type { AttrBag, AttrScalar, AttrValue, AttrValueType } from './attrs.js';
export { addEdge, addGraph, addNode, createGraphSpace } from './build.js';
export type { EdgeInit, GraphInit, NodeInit } from './build.js';
export {
  CURRENT_FORMAT_VERSION,
  decode,
  encode,
  encodeCanonical,
  encodePretty,
} from './codec.js';
export type {
  DecodeOptions,
  DecodeResult,
  DocumentProducer,
  EncodeOptions,
  GraphDocument,
  Migration,
} from './codec.js';
export { MeridianError } from './errors.js';
export {
  asEdgeId,
  asGraphId,
  asNodeId,
  COORD_SEPARATOR,
  deriveEdgeId,
  deriveGraphId,
  deriveNodeId,
} from './ids.js';
export type { Brand, EdgeId, GraphId, NodeId, SemanticCoords } from './ids.js';
export type {
  GraphMeta,
  GraphRef,
  GraphSpace,
  SemanticEdge,
  SemanticGraph,
  SemanticNode,
  SourceRef,
} from './model.js';
export {
  canonAttrs,
  canonAttrValue,
  canonNumber,
  canonProvenance,
  nfc,
} from './normalize.js';
export { stats } from './stats.js';
export type { SpaceStats } from './stats.js';
export {
  buildContainmentIndex,
  containingNodeOf,
  containmentPathOf,
  derivedRootsOf,
  detailGraphOf,
} from './traverse.js';
export type { ContainmentRecord } from './traverse.js';
export { validate } from './validate.js';
export type {
  Issue,
  IssueCode,
  IssueSeverity,
  ValidateOptions,
  ValidationResult,
  VocabularyRegistry,
} from './validate.js';
