/**
 * @meridian/adapter-org — the organization domain adapter (AutoBuild
 * integration, ADR-0047). This barrel exports the deterministic skeleton:
 * the plugin, its manifest, the document builder, the contract parser, and
 * the located error type. There is no AI half — org ingest is zero-AI by
 * contract, and any future enrichment reaches the graph as proposals from
 * the composition root (ADR-0034).
 */
export { orgPlugin, manifest } from './plugin.js';
export { buildDocument, DOMAIN, DIRECT_TEAM, SYSTEM_INSTANCE } from './document.js';
export {
  parseOrgSource,
  BUNDLE_SCHEMA_VERSION,
  DEFINITION_SCHEMA_VERSION,
} from './parse.js';
export type {
  OrgBundleIR,
  OrgDefinition,
  OrgGate,
  OrgInstance,
  OrgRun,
  OrgRunEvent,
  OrgTeam,
  OrgWorkflowRow,
  WorkflowNext,
} from './parse.js';
export { OrgParseError } from './errors.js';
export type { OrgErrorLocation } from './errors.js';
