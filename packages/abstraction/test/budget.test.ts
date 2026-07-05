/**
 * Node budget & salience degradation (ADR-0014): the 1M-leaves-under-one-parent
 * kick-in, greedy min-salience collapse, focus/pin protection, and the
 * coverage-wins `budget-exceeded` flag.
 */
import { describe, expect, it } from 'vitest';
import {
  addGraph,
  addNode,
  asGraphId,
  asNodeId,
  createGraphSpace,
  type AttrBag,
  type GraphSpace,
  type SourceRef,
} from '@meridian/graph-core';
import { buildLevelChain, LodResolver, type ZoomPolicy } from '../src/index.js';
import { bigFanSpace, id, matrixSpace, policy3 } from './resolver-fixtures.js';

const FINEST = 0.99;
const twoLevelPolicy = (maxNodes: number): ZoomPolicy => ({ thresholds: [0.5], hysteresis: 0, budget: { maxNodes } });

describe('1M leaves under one parent — budget collapses to the parent, fast', () => {
  it('resolves the 1M-leaf finest cut and rolls it up to {P} under budget', { timeout: 30_000 }, () => {
    const n = 1_000_000;
    const space = bigFanSpace(n);
    const chain = buildLevelChain(space); // depth 2: P at 0, leaves at 1
    const resolver = new LodResolver(space, chain, twoLevelPolicy(100));

    const t0 = performance.now();
    const r = resolver.resolve({ zoom: FINEST, overrides: new Map() });
    const ms = performance.now() - t0;
    console.log(`[budget] 1M-leaf resolve: ${ms.toFixed(1)}ms → ${r.cut.members.length} member(s)`);

    expect(r.cut.members).toEqual([id('P')]);
    expect(r.provenance.reasons.get(id('P'))).toBe('budget');
    expect(r.provenance.budget?.exceeded).toBe(false);
    expect(r.provenance.budget?.collapsed).toHaveLength(1);
    expect(r.provenance.budget?.collapsed[0]!.replaced).toHaveLength(n);
    expect(r.cut.coverage.covers).toBe(true);
    // Pathological fixture: the point is that budget kicks in and it completes.
    // Generous bound to stay non-flaky on slow CI; real number is logged above.
    expect(ms).toBeLessThan(20_000);
  });

  it('no degradation when the cut already fits the budget', () => {
    const space = bigFanSpace(10);
    const chain = buildLevelChain(space);
    const resolver = new LodResolver(space, chain, twoLevelPolicy(100));
    const r = resolver.resolve({ zoom: FINEST, overrides: new Map() });
    expect(r.cut.members).toHaveLength(10);
    expect(r.provenance.budget?.collapsed).toEqual([]);
    expect(r.provenance.budget?.exceeded).toBe(false);
  });
});

const SRC: SourceRef = { origin: 'source', uri: 'test://budget' };

/** g0 → C(→ c1,c2), D(→ d1,d2); optional per-leaf attrs. */
function twoSubtreeSpace(attrs: Record<string, AttrBag> = {}): GraphSpace {
  let s = createGraphSpace();
  for (const g of ['g0', 'gC', 'gD']) s = addGraph(s, { id: asGraphId(g), label: g, domain: 'doc', provenance: SRC });
  const leaf = (graph: string, node: string): void => {
    s = addNode(s, asGraphId(graph), {
      id: asNodeId(node),
      kind: 'doc:leaf',
      label: node,
      ...(attrs[node] ? { attrs: attrs[node] } : {}),
      provenance: SRC,
    });
  };
  leaf('gC', 'c1');
  leaf('gC', 'c2');
  leaf('gD', 'd1');
  leaf('gD', 'd2');
  s = addNode(s, asGraphId('g0'), { id: asNodeId('C'), kind: 'doc:group', label: 'C', detail: { graph: asGraphId('gC') }, provenance: SRC });
  s = addNode(s, asGraphId('g0'), { id: asNodeId('D'), kind: 'doc:group', label: 'D', detail: { graph: asGraphId('gD') }, provenance: SRC });
  return s;
}

describe('greedy min-salience collapse picks the least-salient region first', () => {
  it('collapses the subtree whose frontier holds the lowest core:salience', () => {
    // D's leaf d1 has salience 0 (lowest), so D collapses before C.
    const space = twoSubtreeSpace({
      c1: { 'core:salience': 9 },
      c2: { 'core:salience': 9 },
      d1: { 'core:salience': 0 },
      d2: { 'core:salience': 9 },
    });
    const chain = buildLevelChain(space);
    const resolver = new LodResolver(space, chain, twoLevelPolicy(3));
    const r = resolver.resolve({ zoom: FINEST, overrides: new Map() });
    expect([...r.cut.members].map(String).sort()).toEqual(['D', 'c1', 'c2']);
    expect(r.provenance.reasons.get(id('D'))).toBe('budget');
    expect(r.provenance.budget?.collapsed[0]!.node).toBe(id('D'));
    expect(r.provenance.budget?.collapsed[0]!.losingSalience).toBe(0);
  });
});

describe('protection: budget never collapses the focus path', () => {
  it('keeps the focused leaf visible while collapsing the periphery', () => {
    const space = matrixSpace();
    const chain = buildLevelChain(space);
    // Finest level = 5 leaves; budget 2 forces degradation, focus A11 protected.
    const resolver = new LodResolver(space, chain, { ...policy3, budget: { maxNodes: 2 } });
    const r = resolver.resolve({ zoom: 0.99, overrides: new Map(), focus: id('A11') });
    const members = [...r.cut.members].map(String).sort();
    expect(members).toContain('A11'); // focus survived
    expect(members).toContain('A12'); // its sibling context (A1 not collapsed)
    expect(members).toContain('B'); // periphery rolled up
    expect(r.provenance.budget?.exceeded).toBe(true); // couldn't reach 2 w/o hiding focus
    expect(r.cut.coverage.covers).toBe(true);
  });
});

describe('protection: budget never collapses a pinned subtree', () => {
  it('emits an over-budget cut with budget-exceeded when pins block collapse', () => {
    const space = matrixSpace();
    const chain = buildLevelChain(space);
    const resolver = new LodResolver(space, chain, { ...policy3, budget: { maxNodes: 2 } });
    const overrides = new Map([
      [id('A11'), 'pin' as const],
      [id('A12'), 'pin' as const],
    ]);
    const r = resolver.resolve({ zoom: 0.99, overrides });
    const members = [...r.cut.members].map(String).sort();
    expect(members).toEqual(['A11', 'A12', 'A2', 'B']);
    expect(r.provenance.budget?.exceeded).toBe(true);
    expect(r.provenance.reasons.get(id('A11'))).toBe('pin');
  });
});
