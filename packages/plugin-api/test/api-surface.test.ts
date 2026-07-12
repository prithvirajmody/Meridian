/**
 * API surface snapshot: the contract's runtime surface is versioned law
 * (ADR-0010) — changing this list is an intentional, reviewed act that must
 * be reflected in CHANGELOG.md and, if breaking, a version bump.
 */
import { describe, expect, it } from 'vitest';
import type {
  AbstractionProposal,
  AbstractionProvider,
  DetailGraphRef,
  DetailNode,
  DetailResolver,
  IngestSink,
  LevelChainSpec,
  PluginManifest,
} from '../src/index.js';
import * as api from '../src/index.js';

describe('@meridian/plugin-api public surface', () => {
  it('exports exactly the committed names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'CAPABILITY_KINDS',
      'NAMESPACED_KEY_PATTERN',
      'PLUGIN_API_VERSION',
    ]);
  });

  it('capability kinds are the enum with 7F’s appended detail-resolver, in declaration order', () => {
    expect(api.CAPABILITY_KINDS).toEqual([
      'domain-parser',
      'abstraction-provider',
      'layout-provider',
      'view-projection',
      'ai-provider',
      // Phase 7F (ADR-0027): first post-P2 runtime-surface change, minor bump.
      'detail-resolver',
    ]);
  });

  it('the API version is valid semver', () => {
    expect(api.PLUGIN_API_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('the Phase 3B type surface is exported and shaped (compile-time)', () => {
    // Type-only additions do not change the runtime surface above; this block
    // pins their shapes so a breaking edit fails `pnpm typecheck` (ADR-0010).
    const chain: LevelChainSpec = {
      domain: 'x',
      levels: [{ name: 'coarse' }, { name: 'fine' }],
    };
    const manifest: PluginManifest = {
      name: '@meridian/x',
      version: '0.0.0',
      apiVersion: '^0.1.0',
      capabilities: [{ kind: 'abstraction-provider', id: 'x' }],
      levelChain: chain,
    };
    const proposal: AbstractionProposal = { groups: [] };
    const provider: AbstractionProvider = {
      id: 'x',
      propose: async () => proposal,
    };
    expect(manifest.levelChain?.levels.length).toBe(2);
    expect(provider.id).toBe('x');
  });

  it('the Phase 7F detail-resolver type surface is exported and shaped (compile-time)', () => {
    // Type-only shapes for the `detail-resolver` contract (ADR-0027). Pinned so
    // a breaking edit fails `pnpm typecheck` (ADR-0010).
    const detailManifest: PluginManifest = {
      name: '@meridian/y',
      version: '0.0.0',
      apiVersion: '^0.2.0',
      capabilities: [{ kind: 'detail-resolver', id: 'y' }],
    };
    const ref: DetailGraphRef = { graph: 'g-detail' };
    const resolver: DetailResolver = {
      id: 'y',
      canResolve: (n: DetailNode) => n.detail === undefined,
      resolve: async (_n: DetailNode, sink: IngestSink) => {
        sink.emitDelta({ ops: [] });
        return ref;
      },
    };
    expect(detailManifest.capabilities[0]?.kind).toBe('detail-resolver');
    expect(resolver.id).toBe('y');
    expect(ref.graph).toBe('g-detail');
  });
});
