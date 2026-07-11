/**
 * Structural-twin assignability (ROADMAP 4B deliverable 6; the same mechanism
 * that pins `LevelChainSpec` and `AbstractionProvider`). The real layout
 * `LayoutProvider` contract and plugin-api's `layout-provider` twin cannot
 * import each other (ADR-0015 dependency law), so this compile-time check
 * asserts the real providers are assignable to the plugin-api twin — if the
 * two shapes drift, this test fails to typecheck.
 */
import { describe, expect, it } from 'vitest';
import type { LayoutProvider as PluginLayoutProvider } from '@meridian/plugin-api';
import { gridProvider, treeProvider } from '../src/index.js';

describe('plugin-api layout-provider structural twin', () => {
  it('grid and tree providers are assignable to the plugin-api LayoutProvider', () => {
    const g: PluginLayoutProvider = gridProvider;
    const t: PluginLayoutProvider = treeProvider;
    expect(g.id).toBe('grid');
    expect(t.id).toBe('tree');
    expect(g.capabilities.deterministic).toBe(true);
    expect(t.capabilities.deterministic).toBe(true);
  });
});
