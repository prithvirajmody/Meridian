/**
 * Cold-aware LOD (ADR-0039 §7, SUBPHASES 11C): `LodRequest.cold` is a pure
 * input naming unhydrated shell graphs. Where descent was warranted (depth
 * below base, or an expand override) but the detail graph is cold, the node
 * is emitted with reason `cold` (the tag ADR-0012 reserved) and listed in
 * `frontier.needsHydration` AND `frontier.expandable` — expanding it is the
 * hydration trigger. Cuts never block on cold graphs: coverage holds.
 *
 * Space: `bigFanSpace(2)` — root graph 'root' holds P whose detail graph
 * 'detail' holds two leaves; the spine variant carries 'detail' as an empty
 * shell. The level chain is built from the full space (the manifest knows
 * the true depth; the spine alone reads as depth 0).
 */
import { asGraphId, type GraphSpace, type SemanticGraph } from '@meridian/graph-core';
import { describe, expect, it } from 'vitest';
import { buildLevelChain, LodResolver, type LodRequest, type ZoomPolicy } from '../src/index.js';
import { bigFanSpace, id } from './resolver-fixtures.js';

const FINEST = 0.99;
const COARSE = 0.2;
/** Same shape as budget.test.ts's twoLevelPolicy, sans budget. */
const twoLevelPolicy: ZoomPolicy = { thresholds: [0.5], hysteresis: 0 };

const detailId = asGraphId('detail');
const fullSpace = bigFanSpace(2); // root: P → detail: L0, L1
const chain = buildLevelChain(fullSpace); // depths 0..1

/** The spine variant: 'detail' present as an empty shell (same meta). */
function spineSpace(): GraphSpace {
  const shell: SemanticGraph = {
    ...fullSpace.graphs.get(detailId)!,
    nodes: new Map(),
    edges: new Map(),
  };
  const graphs = new Map(fullSpace.graphs);
  graphs.set(detailId, shell);
  return { graphs, roots: fullSpace.roots };
}

describe('cold shells at a descending base level', () => {
  it('emits P with reason cold, on both hydration frontiers, still covering', () => {
    const resolver = new LodResolver(spineSpace(), chain, twoLevelPolicy);
    const r = resolver.resolve({
      zoom: FINEST, // base level 1 — descent into P is warranted
      overrides: new Map(),
      cold: new Set([detailId]),
    });
    expect(r.cut.members).toEqual([id('P')]);
    expect(r.provenance.reasons.get(id('P'))).toBe('cold');
    expect(r.frontier.needsHydration).toEqual([id('P')]);
    expect(r.frontier.expandable).toContain(id('P'));
    expect(r.cut.coverage.covers).toBe(true); // the cut never blocks on cold
  });

  it('without the cold input, a shell reads as an ordinary leaf', () => {
    const resolver = new LodResolver(spineSpace(), chain, twoLevelPolicy);
    const r = resolver.resolve({ zoom: FINEST, overrides: new Map() });
    expect(r.cut.members).toEqual([id('P')]);
    expect(r.provenance.reasons.get(id('P'))).toBe('leaf');
    expect(r.frontier.needsHydration).toEqual([]);
    expect(r.frontier.expandable).toEqual([]); // structurally a leaf, no cold info
    expect(r.cut.coverage.covers).toBe(true);
  });
});

describe('overrides against a cold detail', () => {
  it('an expand override cannot descend a cold graph: reason cold, needs hydration', () => {
    const resolver = new LodResolver(spineSpace(), chain, twoLevelPolicy);
    const r = resolver.resolve({
      zoom: COARSE, // base 0 — only the override asks for descent
      overrides: new Map([[id('P'), 'expand' as const]]),
      cold: new Set([detailId]),
    });
    expect(r.cut.members).toEqual([id('P')]);
    expect(r.provenance.reasons.get(id('P'))).toBe('cold');
    expect(r.frontier.needsHydration).toEqual([id('P')]);
    expect(r.frontier.expandable).toContain(id('P'));
  });
});

describe('cold detail where no descent is warranted', () => {
  it('keeps the level reason but still flags the hydration frontier', () => {
    // Full space + cold set models the moment the manager's cold set lags the
    // space (or an eviction is pending): descent is not warranted at base 0,
    // so the inclusion reason is untouched — only the frontier flags it.
    const resolver = new LodResolver(fullSpace, chain, twoLevelPolicy);
    const r = resolver.resolve({
      zoom: COARSE, // base 0 — P is emitted at its own level
      overrides: new Map(),
      cold: new Set([detailId]),
    });
    expect(r.cut.members).toEqual([id('P')]);
    expect(r.provenance.reasons.get(id('P'))).toBe('level');
    expect(r.frontier.needsHydration).toEqual([id('P')]);
    expect(r.frontier.expandable).toContain(id('P'));
  });

  it('on the spine at base 0 the shell reads leaf, yet still needs hydration', () => {
    const resolver = new LodResolver(spineSpace(), chain, twoLevelPolicy);
    const r = resolver.resolve({
      zoom: COARSE,
      overrides: new Map(),
      cold: new Set([detailId]),
    });
    expect(r.provenance.reasons.get(id('P'))).toBe('leaf');
    expect(r.frontier.needsHydration).toEqual([id('P')]);
    expect(r.frontier.expandable).toContain(id('P'));
  });
});

describe('hydrated space descends normally', () => {
  it('an empty cold set changes nothing: child nodes in the cut, no hydration frontier', () => {
    const resolver = new LodResolver(fullSpace, chain, twoLevelPolicy);
    const r = resolver.resolve({ zoom: FINEST, overrides: new Map(), cold: new Set() });
    expect(r.cut.members).toEqual([id('L0'), id('L1')]);
    expect(r.provenance.reasons.get(id('L0'))).toBe('leaf');
    expect(r.frontier.needsHydration).toEqual([]);
    expect(r.cut.coverage.covers).toBe(true);
  });
});

describe('determinism with cold sets (I6)', () => {
  it('two identical cold resolves are deeply equal', () => {
    const resolver = new LodResolver(spineSpace(), chain, twoLevelPolicy);
    const req: LodRequest = {
      zoom: FINEST,
      overrides: new Map(),
      cold: new Set([detailId]),
    };
    const a = resolver.resolve(req);
    const b = resolver.resolve(req);
    expect(b).toEqual(a);
  });
});
