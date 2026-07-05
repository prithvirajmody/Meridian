/**
 * Resolver determinism by result-hashing (ROADMAP Phase 3 §11): the same
 * request over the same snapshot yields a byte-identical result (I6), across
 * many random forests, edge sets, override maps, budgets and prev-levels — and
 * across independently constructed resolver instances.
 */
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildLevelChain, LodResolver, type LodResult, type ZoomPolicy } from '../src/index.js';
import { forestSpaceWithEdgesArb } from './arbitraries.js';
import { requestArb } from './resolver-arbitraries.js';

const policy: ZoomPolicy = { thresholds: [0.25, 0.5, 0.75], hysteresis: 0.1 };

/** A canonical, order-stable digest of everything the resolver decides. */
function digest(r: LodResult): string {
  const canon = {
    level: r.provenance.level,
    nominal: r.provenance.nominalLevel,
    members: r.cut.members.map((m) => [m, r.provenance.reasons.get(m)]),
    covers: r.cut.coverage.covers,
    induced: r.inducedEdges.map((e) => [e.src, e.dst, e.kind, e.weight, e.multiplicity, [...e.samples]]),
    capped: r.cappedEdges.edges.map((e) => [e.src, e.dst, e.kind]),
    residuals: r.cappedEdges.residuals.map((x) => [x.node, x.direction, x.hidden, x.weight, x.multiplicity]),
    expandable: [...r.frontier.expandable],
    collapsible: [...r.frontier.collapsible],
    ignored: r.provenance.ignoredOverrides.map((o) => [o.node, o.kind, o.reason]),
    budget: r.provenance.budget
      ? {
          maxNodes: r.provenance.budget.maxNodes,
          exceeded: r.provenance.budget.exceeded,
          collapsed: r.provenance.budget.collapsed.map((c) => [c.node, [...c.replaced], c.losingSalience]),
        }
      : null,
  };
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

describe('resolveLod is a pure deterministic function (hash-verified)', () => {
  it('identical requests hash identically, on the same and on fresh resolvers', () => {
    fc.assert(
      fc.property(
        forestSpaceWithEdgesArb.chain((space) => requestArb(space).map((req) => ({ space, req }))),
        ({ space, req }) => {
          const chain = buildLevelChain(space);
          const a = new LodResolver(space, chain, policy);
          const b = new LodResolver(space, chain, policy); // independently built index
          const h1 = digest(a.resolve(req));
          const h2 = digest(a.resolve(req)); // same instance, twice
          const h3 = digest(b.resolve(req)); // fresh instance
          expect(h2).toBe(h1);
          expect(h3).toBe(h1);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('never throws for any request in the space', () => {
    fc.assert(
      fc.property(
        forestSpaceWithEdgesArb.chain((space) => requestArb(space).map((req) => ({ space, req }))),
        ({ space, req }) => {
          const chain = buildLevelChain(space);
          expect(() => new LodResolver(space, chain, policy).resolve(req)).not.toThrow();
        },
      ),
      { numRuns: 300 },
    );
  });
});
