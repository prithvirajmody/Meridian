/**
 * API surface snapshot: the contract's runtime surface is versioned law
 * (ADR-0010) — changing this list is an intentional, reviewed act that must
 * be reflected in CHANGELOG.md and, if breaking, a version bump.
 */
import { describe, expect, it } from 'vitest';
import type {
  AbstractionProposal,
  AbstractionProvider,
  ProposedGroup,
  DetailGraphRef,
  DetailNode,
  DetailResolver,
  IncrementalAdapter,
  IngestSink,
  LevelChainSpec,
  PluginManifest,
  SourceChange,
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

  it('the Phase 9C ProposedGroup.kind field is exported and shaped (compile-time)', () => {
    // Type-only additive field (ADR-0010: no runtime surface change, no bump):
    // a proposal may type its group node with a domain kind (ADR-0034).
    const typed: ProposedGroup = {
      id: 'g',
      label: 'Topic',
      members: ['a'],
      rationale: 'r',
      kind: 'conv:topic',
    };
    expect(typed.kind).toBe('conv:topic');
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

  it('the Phase 7G incremental type surface is exported and shaped (compile-time)', () => {
    // Type-only shapes for watch-mode (ADR-0028 / ROADMAP §7): a `SourceChange`
    // in, a minimal delta out through the ordinary sink. No runtime surface
    // change (types erase), so no version bump — pinned so a breaking edit fails
    // `pnpm typecheck` (ADR-0010).
    const del: SourceChange = { path: 'src/a.ts', newText: undefined };
    const mod: SourceChange = { path: 'src/a.ts', oldText: 'a', newText: 'b' };
    const adapter: IncrementalAdapter = {
      update: async (_change: SourceChange, sink: IngestSink) => {
        sink.emitDelta({ ops: [] });
      },
    };
    expect(del.newText).toBeUndefined();
    expect(mod.oldText).toBe('a');
    expect(typeof adapter.update).toBe('function');
  });
});
