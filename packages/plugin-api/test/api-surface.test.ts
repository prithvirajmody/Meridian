/**
 * API surface snapshot: the contract's runtime surface is versioned law
 * (ADR-0010) — changing this list is an intentional, reviewed act that must
 * be reflected in CHANGELOG.md and, if breaking, a version bump.
 */
import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';

describe('@meridian/plugin-api public surface', () => {
  it('exports exactly the committed names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'CAPABILITY_KINDS',
      'NAMESPACED_KEY_PATTERN',
      'PLUGIN_API_VERSION',
    ]);
  });

  it('capability kinds are the ADR-0011 v1 enum, in declaration order', () => {
    expect(api.CAPABILITY_KINDS).toEqual([
      'domain-parser',
      'abstraction-provider',
      'layout-provider',
      'view-projection',
      'ai-provider',
    ]);
  });

  it('the API version is valid semver', () => {
    expect(api.PLUGIN_API_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
