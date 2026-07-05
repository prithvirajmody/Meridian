/**
 * A plugin module's single export (ADR-0009): a manifest plus `activate`.
 * No module-scope side effects — importing a plugin does nothing; all work
 * happens inside `activate` or capability calls.
 */
import type { PluginContext } from './context.js';
import type { PluginManifest } from './manifest.js';
import type { DomainParser } from './parser.js';

/** What `activate` returns: one implementation per declared capability.
 * v1 routes `domain-parser` only (ADR-0011). */
export interface PluginExports {
  readonly parsers?: readonly DomainParser[];
}

export interface MeridianPlugin {
  readonly manifest: PluginManifest;
  activate(ctx: PluginContext): PluginExports;
}
