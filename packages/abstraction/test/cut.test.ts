/**
 * Cut construction on the named edge fixtures (roadmap Phase 3 §12 failure
 * cases): empty, single-node, ragged, orphan, and empty-detail spaces. Every
 * cut must carry a valid covering proof (I5) and a well-formed trace.
 */
import { asNodeId, type NodeId } from '@meridian/graph-core';
import { describe, expect, it } from 'vitest';
import { buildCut, verifyCoverage } from '../src/cut.js';
import { buildLevelChain } from '../src/level-chain.js';
import {
  emptyDetailSpace,
  emptySpace,
  laddderSpace,
  orphanSpace,
  raggedSpace,
  singleNodeSpace,
} from './fixtures.js';

const n = (id: string): NodeId => asNodeId(id);

describe('buildCut — edge fixtures', () => {
  it('empty space: empty cut, coverage holds vacuously', () => {
    const space = emptySpace();
    const cut = buildCut(space, buildLevelChain(space), 0);
    expect(cut.members).toEqual([]);
    expect(cut.coverage).toEqual({ leaves: 0, coveredLeaves: 0, covers: true });
    expect(verifyCoverage(space, cut).ok).toBe(true);
  });

  it('single-node space: the node is the cut at any level', () => {
    const space = singleNodeSpace();
    const chain = buildLevelChain(space);
    for (const level of [0, 1, 5]) {
      const cut = buildCut(space, chain, level);
      expect(cut.members).toEqual([n('n')]);
      expect(cut.trace.get(n('n'))?.coveredLeaves).toBe(1);
      expect(verifyCoverage(space, cut).ok).toBe(true);
    }
  });

  it('ladder: coarse cut collapses to the root, fine cut reaches the leaf', () => {
    const space = laddderSpace();
    const chain = buildLevelChain(space);
    const coarse = buildCut(space, chain, 0);
    expect(coarse.members).toEqual([n('n0')]);
    expect(coarse.trace.get(n('n0'))).toMatchObject({ depth: 0, reason: 'level', coveredLeaves: 1 });

    const mid = buildCut(space, chain, 1);
    expect(mid.members).toEqual([n('n1')]);

    const fine = buildCut(space, chain, 2);
    expect(fine.members).toEqual([n('n2')]);
    expect(fine.trace.get(n('n2'))?.reason).toBe('level');
  });

  it('ragged hierarchy: short paths emit their leaf, deep paths emit the level node', () => {
    const space = raggedSpace();
    const chain = buildLevelChain(space);
    expect(chain.depth).toBe(3); // deepest leaf C11 at depth 2

    // At level 0 everything rolls up to the three root nodes.
    const top = buildCut(space, chain, 0);
    expect(top.members).toEqual([n('A'), n('B'), n('C')]);
    expect(top.trace.get(n('A'))?.reason).toBe('level');

    // At level 2: A (leaf, depth 0) and B1 (leaf, depth 1) are emitted early;
    // only C's branch reaches depth 2 (C11).
    const deep = buildCut(space, chain, 2);
    expect([...deep.members].sort()).toEqual([n('A'), n('B1'), n('C11')].sort());
    expect(deep.trace.get(n('A'))?.reason).toBe('leaf');
    expect(deep.trace.get(n('B1'))?.reason).toBe('leaf');
    expect(deep.trace.get(n('C11'))?.reason).toBe('level');
    expect(verifyCoverage(space, deep).ok).toBe(true);
  });

  it('orphan across two root graphs: coverage spans both roots', () => {
    const space = orphanSpace();
    const chain = buildLevelChain(space);
    for (let level = 0; level < chain.depth + 1; level++) {
      const cut = buildCut(space, chain, level);
      expect(verifyCoverage(space, cut).ok).toBe(true);
    }
    // At the finest level both leaves (m1, orphan) are visible.
    const fine = buildCut(space, chain, chain.depth);
    expect([...fine.members].sort()).toEqual([n('m1'), n('orphan')].sort());
  });

  it('empty detail graph: the container counts as a leaf', () => {
    const space = emptyDetailSpace();
    const chain = buildLevelChain(space);
    expect(chain.depth).toBe(1); // e and n both leaves at depth 0
    const cut = buildCut(space, chain, 0);
    expect([...cut.members].sort()).toEqual([n('e'), n('n')].sort());
    expect(cut.trace.get(n('e'))?.coveredLeaves).toBe(1);
    expect(verifyCoverage(space, cut).ok).toBe(true);
  });

  it('rejects a negative or non-integer level', () => {
    const space = singleNodeSpace();
    const chain = buildLevelChain(space);
    expect(() => buildCut(space, chain, -1)).toThrow(RangeError);
    expect(() => buildCut(space, chain, 1.5)).toThrow(RangeError);
  });
});
