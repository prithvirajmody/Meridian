/**
 * I5 (cut coverage) holds for arbitrary override maps and budgets (ROADMAP
 * Phase 3 §11–12). The resolver's cut — after overrides, deepest-wins piercing,
 * and budget rollups — must still cover every forest leaf exactly once. Checked
 * by an independent method (root→leaf paths), not the builder's own proof, so
 * this tests the invariant, not the code against itself.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { NodeId } from '@meridian/graph-core';
import { buildLevelChain, collectLeafPaths, LodResolver, type ZoomPolicy } from '../src/index.js';
import { forestSpaceWithEdgesArb } from './arbitraries.js';
import { requestArb } from './resolver-arbitraries.js';

const policy: ZoomPolicy = { thresholds: [0.25, 0.5, 0.75], hysteresis: 0.05 };

/** Independent I5 check for an arbitrary antichain: every root→leaf path has
 * exactly one of its nodes (leaf inclusive) in the member set. */
function coversExactlyOnce(space: Parameters<typeof collectLeafPaths>[0], members: ReadonlySet<NodeId>): boolean {
  for (const path of collectLeafPaths(space)) {
    let hits = 0;
    for (const anc of path.ancestors) if (members.has(anc)) hits++;
    if (hits !== 1) return false;
  }
  return true;
}

describe('I5 — the resolved cut covers every leaf exactly once', () => {
  it('holds for random spaces × random overrides × random budgets', () => {
    fc.assert(
      fc.property(
        forestSpaceWithEdgesArb.chain((space) => requestArb(space).map((req) => ({ space, req }))),
        ({ space, req }) => {
          const chain = buildLevelChain(space);
          const result = new LodResolver(space, chain, policy).resolve(req);
          const members = new Set<NodeId>(result.cut.members);
          // The builder's own proof and the independent path check must agree.
          expect(result.cut.coverage.covers).toBe(true);
          expect(coversExactlyOnce(space, members)).toBe(true);
          // No duplicate members (antichain minimality).
          expect(members.size).toBe(result.cut.members.length);
        },
      ),
      { numRuns: 400 },
    );
  });
});
