/**
 * Resolver failure/edge fixtures (ROADMAP Phase 3 §12): empty and single-node
 * graphs resolve to a valid (possibly empty) covering cut, never throw, and
 * carry a coherent trace — including under overrides and a tight budget.
 */
import { describe, expect, it } from 'vitest';
import { buildLevelChain, LodResolver, type OverrideKind } from '../src/index.js';
import { emptySpace, singleNodeSpace } from './fixtures.js';
import { policy3 } from './resolver-fixtures.js';
import { asNodeId } from '@meridian/graph-core';

describe('empty graph', () => {
  it('resolves to an empty, trivially-covering cut', () => {
    const space = emptySpace();
    const r = new LodResolver(space, buildLevelChain(space), policy3).resolve({ zoom: 0.5, overrides: new Map() });
    expect(r.cut.members).toEqual([]);
    expect(r.cut.coverage.covers).toBe(true);
    expect(r.inducedEdges).toEqual([]);
    expect(r.frontier.expandable).toEqual([]);
  });

  it('ignores overrides against a non-existent node without throwing', () => {
    const space = emptySpace();
    const overrides = new Map<ReturnType<typeof asNodeId>, OverrideKind>([[asNodeId('x'), 'pin']]);
    const r = new LodResolver(space, buildLevelChain(space), policy3).resolve({ zoom: 0.5, overrides });
    expect(r.provenance.ignoredOverrides).toEqual([{ node: asNodeId('x'), kind: 'pin', reason: 'removed' }]);
  });
});

describe('single-node graph', () => {
  it('the lone node is the whole cut at any zoom', () => {
    const space = singleNodeSpace();
    const resolver = new LodResolver(space, buildLevelChain(space), policy3);
    for (const zoom of [0, 0.5, 1]) {
      const r = resolver.resolve({ zoom, overrides: new Map() });
      expect([...r.cut.members].map(String)).toEqual(['n']);
      expect(r.cut.coverage.covers).toBe(true);
    }
  });

  it('survives a zero budget (coverage wins) with budget-exceeded traced', () => {
    const space = singleNodeSpace();
    const resolver = new LodResolver(space, buildLevelChain(space), { ...policy3, budget: { maxNodes: 0 } });
    const r = resolver.resolve({ zoom: 1, overrides: new Map() });
    expect([...r.cut.members].map(String)).toEqual(['n']);
    expect(r.provenance.budget?.exceeded).toBe(true);
    expect(r.cut.coverage.covers).toBe(true);
  });
});
