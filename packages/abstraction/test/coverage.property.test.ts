/**
 * I5 — cut coverage (ARCHITECTURE.md §3.2; ROADMAP §5.3). On random
 * containment forests, at every base level, the resolved cut must cover every
 * leaf exactly once. Checked two ways that must agree: the builder's
 * subtree-count proof (`cut.coverage`) and the path-based `verifyCoverage`.
 */
import { detailGraphOf, type GraphSpace, type NodeId } from '@meridian/graph-core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildCut, verifyCoverage } from '../src/cut.js';
import { buildLevelChain } from '../src/level-chain.js';
import { maxDepth } from '../src/forest.js';
import { forestSpaceArb } from './arbitraries.js';

/** Ancestor→descendant containment among nodes, for the antichain check. */
function isAncestor(space: GraphSpace, ancestor: NodeId, descendant: NodeId): boolean {
  // Walk the ancestor's subtree looking for the descendant.
  const node = findNode(space, ancestor);
  if (node === undefined) return false;
  const detail = detailGraphOf(space, node);
  if (detail === undefined) return false;
  const stack = [...detail.nodes.values()];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.id === descendant) return true;
    const d = detailGraphOf(space, n);
    if (d !== undefined) stack.push(...d.nodes.values());
  }
  return false;
}

function findNode(space: GraphSpace, id: NodeId) {
  for (const graph of space.graphs.values()) {
    const node = graph.nodes.get(id);
    if (node !== undefined) return node;
  }
  return undefined;
}

describe('I5 — cut coverage over random forests', () => {
  it('every leaf is covered exactly once, at every level (default chain)', () => {
    fc.assert(
      fc.property(forestSpaceArb, (space) => {
        const chain = buildLevelChain(space);
        const deepest = maxDepth(space);
        // Include one level past the deepest node: asking for more detail than
        // exists must still cover (all leaves).
        for (let level = 0; level <= deepest + 1; level++) {
          const cut = buildCut(space, chain, level);
          const check = verifyCoverage(space, cut);
          expect(check.ok, `level ${level}: ${JSON.stringify(check)}`).toBe(true);
          expect(cut.coverage.covers, `level ${level} builder proof`).toBe(true);
          expect(cut.coverage.coveredLeaves).toBe(cut.coverage.leaves);
          expect(check.totalLeaves).toBe(cut.coverage.leaves);
        }
      }),
    );
  });

  it('cut members form an antichain (no member contains another)', () => {
    fc.assert(
      fc.property(forestSpaceArb, (space) => {
        const chain = buildLevelChain(space);
        const deepest = maxDepth(space);
        for (let level = 0; level <= deepest + 1; level++) {
          const members = buildCut(space, chain, level).members;
          for (const a of members) {
            for (const b of members) {
              if (a !== b) expect(isAncestor(space, a, b)).toBe(false);
            }
          }
        }
      }),
    );
  });

  it('buildCut is deterministic (same request → identical members)', () => {
    fc.assert(
      fc.property(forestSpaceArb, fc.nat(6), (space, level) => {
        const chain = buildLevelChain(space);
        const a = buildCut(space, chain, level);
        const b = buildCut(space, chain, level);
        expect(a.members).toEqual(b.members);
      }),
    );
  });

  it('coverage holds under a declared spec chain too (names do not move nodes)', () => {
    fc.assert(
      fc.property(forestSpaceArb, fc.integer({ min: 1, max: 5 }), (space, levelCount) => {
        const chain = buildLevelChain(space, {
          domain: 'declared',
          levels: Array.from({ length: levelCount }, (_, i) => ({ name: `L${i}` })),
        });
        for (let level = 0; level < chain.depth; level++) {
          expect(verifyCoverage(space, buildCut(space, chain, level)).ok).toBe(true);
        }
      }),
    );
  });
});
