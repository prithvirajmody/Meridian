/**
 * Plugin manifests (ARCHITECTURE.md §14.2): identity, API compatibility,
 * capability declarations, and vocabulary contributions (kinds + attribute
 * schemas, U8). Manifests are plain data — the host schema-parses them; an
 * invalid manifest never loads.
 */
import type { AttrValueType } from '@meridian/graph-core';
import type { CapabilityKind } from './capabilities.js';
import type { LevelChainSpec } from './levels.js';

/**
 * The `ns:name` grammar for namespaced kinds and attr keys. Mirrors
 * graph-core's `ATTR_KEY_PATTERN` (ADR-0003) — restated here because plugins
 * and the host see only this package; the conformance kit asserts the two
 * patterns stay identical.
 */
export const NAMESPACED_KEY_PATTERN = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;

/** One capability contribution. `id` is unique per (plugin, kind); for
 * `domain-parser` it names the domain the exported parser must carry. */
export interface CapabilityDeclaration {
  readonly kind: CapabilityKind;
  readonly id: string;
}

/** Declared value shape for one namespaced attr key (U8, ADR-0003). */
export interface AttrSchema {
  readonly type: AttrValueType;
  readonly description: string;
}

export interface PluginManifest {
  /** Package-style unique name, e.g. `@meridian/adapter-<domain>`. */
  readonly name: string;
  /** The plugin's own semver. */
  readonly version: string;
  /** Semver range (exact or caret) against `PLUGIN_API_VERSION` (ADR-0010). */
  readonly apiVersion: string;
  readonly capabilities: readonly CapabilityDeclaration[];
  /** Node/edge kinds this plugin's output may use (U8). `core:*` is implicit. */
  readonly kinds?: readonly string[];
  /** Attr keys this plugin's output may use, with declared types (U8). */
  readonly attrSchemas?: Readonly<Record<string, AttrSchema>>;
  /** Optional named abstraction levels for this plugin's domain (§7.2.1). A
   * parser that declares none gets a default containment-depth chain (P3). */
  readonly levelChain?: LevelChainSpec;
}
