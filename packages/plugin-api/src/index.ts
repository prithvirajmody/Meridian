/**
 * The Meridian plugin contract (Phase 2). Types and capability descriptors
 * only (ARCHITECTURE.md §20): plugins compile against this package and
 * nothing else of Meridian's internals. Everything that crosses this boundary
 * is structured-clone-safe (ADR-0009) so the Phase 12 worker isolation is a
 * host change, not a plugin change.
 */
// Wire-form types plugins build against, re-exported because plugins and the
// host see only this package (§20): the document IS the IR (§6.1).
export type { AttrValueType, GraphDocument, SemanticCoords } from '@meridian/graph-core';
export { CAPABILITY_KINDS } from './capabilities.js';
export type { CapabilityKind } from './capabilities.js';
export type { EdgeCoords, IdFacade, PluginContext, PluginLogger } from './context.js';
export { NAMESPACED_KEY_PATTERN } from './manifest.js';
export type { AttrSchema, CapabilityDeclaration, PluginManifest } from './manifest.js';
export type {
  DeltaWire,
  DomainParser,
  IngestReport,
  IngestSink,
  ProvenanceTally,
} from './parser.js';
export type { MeridianPlugin, PluginExports } from './plugin.js';
export type { Progress, SourceDescriptor } from './source.js';
export { PLUGIN_API_VERSION } from './version.js';
