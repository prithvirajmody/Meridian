/**
 * A plugin module's single export (ADR-0009): a manifest plus `activate`.
 * No module-scope side effects — importing a plugin does nothing; all work
 * happens inside `activate` or capability calls.
 */
import type { AbstractionProvider } from './abstraction.js';
import type { PluginContext } from './context.js';
import type { PluginManifest } from './manifest.js';
import type { DomainParser } from './parser.js';

/** What `activate` returns: one implementation per declared capability.
 * The host routes `domain-parser` today; `abstractionProviders` is the
 * Phase 3 capability seam (types only until 3D wires it). */
export interface PluginExports {
  readonly parsers?: readonly DomainParser[];
  readonly abstractionProviders?: readonly AbstractionProvider[];
}

export interface MeridianPlugin {
  readonly manifest: PluginManifest;
  activate(ctx: PluginContext): PluginExports;
}
