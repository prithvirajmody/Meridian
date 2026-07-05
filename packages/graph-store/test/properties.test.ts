/**
 * Property suites (ROADMAP Phase 1 §12): I4 delta soundness (apply → invert
 * → apply ≡ identity), apply/compose equivalence, committed snapshots always
 * validate, indices ≡ brute force, diffSpaces replays a → b for arbitrary
 * pairs, and subscription order under random commit counts.
 */
import fc from 'fast-check';
import { validate, type GraphSpace, type NodeId, type SemanticNode } from '@meridian/graph-core';
import { describe, expect, it } from 'vitest';
import {
  applyDelta,
  composeDeltas,
  createStore,
  diffSpaces,
  invertDelta,
  tokenizeLabel,
  type ChangeSet,
  type GraphDelta,
} from '../src/index.js';
import { mutationCaseArb, spaceArb } from './arbitraries.js';
import { canonical, ORIGIN } from './helpers.js';

describe('I4 — delta soundness', () => {
  it('apply(apply(g, d), invert(d)) ≡ g, and committed states always validate', () => {
    fc.assert(
      fc.property(mutationCaseArb, ({ space, ops }) => {
        const store = createStore(space);
        const before = canonical(store.snapshot());
        const applied = store.apply({ origin: ORIGIN, ops });
        expect(applied.ok, !applied.ok ? JSON.stringify(applied.errors) : '').toBe(true);
        if (!applied.ok) return;
        const after = store.snapshot();
        expect(validate(after).ok).toBe(true);
        expect(isSorted(after.roots)).toBe(true);

        const undone = store.apply(invertDelta(applied.delta));
        expect(undone.ok, !undone.ok ? JSON.stringify(undone.errors) : '').toBe(true);
        expect(canonical(store.snapshot())).toBe(before);
        expect(validate(store.snapshot()).ok).toBe(true);

        // Redo: inverting the inverse replays the original change.
        if (undone.ok) {
          const redone = store.apply(invertDelta(undone.delta));
          expect(redone.ok).toBe(true);
          expect(canonical(store.snapshot())).toBe(canonical(after));
        }
      }),
    );
  });

  it('one delta ≡ per-op transactions ≡ composed delta (space equality)', () => {
    fc.assert(
      fc.property(mutationCaseArb, ({ space, ops }) => {
        const oneShot = createStore(space);
        const r = oneShot.apply({ origin: ORIGIN, ops });
        expect(r.ok).toBe(true);

        const stepwise = createStore(space);
        const deltas: GraphDelta[] = [];
        for (const op of ops) {
          const step = stepwise.apply({ origin: ORIGIN, ops: [op] });
          expect(step.ok).toBe(true);
          if (step.ok) deltas.push(step.delta);
        }
        expect(canonical(stepwise.snapshot())).toBe(canonical(oneShot.snapshot()));

        const composed = createStore(space);
        const c = composed.apply(composeDeltas(deltas[0]!, ...deltas.slice(1)));
        expect(c.ok).toBe(true);
        expect(canonical(composed.snapshot())).toBe(canonical(oneShot.snapshot()));
      }),
    );
  });

  it('pure applyDelta agrees with the store', () => {
    fc.assert(
      fc.property(mutationCaseArb, ({ space, ops }) => {
        const store = createStore(space);
        store.apply({ origin: ORIGIN, ops });
        const pure = applyDelta(space, { origin: ORIGIN, ops });
        expect(pure.ok).toBe(true);
        if (pure.ok) expect(canonical(pure.space)).toBe(canonical(store.snapshot()));
      }),
    );
  });
});

describe('indices ≡ brute force', () => {
  it('query answers match recomputation from the snapshot after random op sequences', () => {
    fc.assert(
      fc.property(mutationCaseArb, ({ space, ops }) => {
        const store = createStore(space);
        const r = store.apply({ origin: ORIGIN, ops });
        expect(r.ok).toBe(true);
        const snapshot = store.snapshot();
        const nodes = allNodes(snapshot);

        const kinds = new Set(nodes.map(({ node }) => node.kind));
        for (const kind of kinds) {
          const expected = nodes.filter(({ node }) => node.kind === kind).map(({ node }) => node.id).sort();
          expect(store.query().byKind(kind).ids()).toEqual(expected);
        }

        const tokens = new Set(nodes.flatMap(({ node }) => tokenizeLabel(node.label)));
        for (const token of tokens) {
          const expected = nodes
            .filter(({ node }) => tokenizeLabel(node.label).includes(token))
            .map(({ node }) => node.id)
            .sort();
          expect(store.query().text(token).ids()).toEqual(expected);
        }

        for (const graph of snapshot.graphs.values()) {
          const expected = [...graph.nodes.keys()].sort();
          expect(store.query().within(graph.id).ids()).toEqual(expected);
          for (const node of graph.nodes.values()) {
            const out = new Set<NodeId>();
            const into = new Set<NodeId>();
            for (const edge of graph.edges.values()) {
              if (edge.src === node.id) out.add(edge.dst);
              if (edge.dst === node.id) into.add(edge.src);
            }
            expect(store.query().neighborsOf(node.id, { direction: 'out' }).ids()).toEqual([...out].sort());
            expect(store.query().neighborsOf(node.id, { direction: 'in' }).ids()).toEqual([...into].sort());
            expect(store.query().neighborsOf(node.id).ids()).toEqual([...new Set([...out, ...into])].sort());
          }
        }
      }),
      { numRuns: 40 }, // the full sweep is quadratic in space size
    );
  });
});

describe('diffSpaces', () => {
  it('replays a → b for arbitrary independent pairs (shared id shapes, different content)', () => {
    fc.assert(
      fc.property(spaceArb, spaceArb, (a, b) => {
        const delta = diffSpaces(a, b);
        const result = applyDelta(a, { ...delta, ops: delta.ops });
        if (delta.ops.length === 0) {
          expect(canonical(a)).toBe(canonical(b));
          return;
        }
        expect(result.ok, !result.ok ? JSON.stringify(result.errors) : '').toBe(true);
        if (result.ok) expect(canonical(result.space)).toBe(canonical(b));
      }),
    );
  });

  it('replays a → mutated(a), and diff(a, a) is empty', () => {
    fc.assert(
      fc.property(mutationCaseArb, ({ space, ops }) => {
        expect(diffSpaces(space, space).ops).toEqual([]);
        const store = createStore(space);
        store.apply({ origin: ORIGIN, ops });
        const target = store.snapshot();
        const delta = diffSpaces(space, target);
        if (delta.ops.length === 0) {
          // Identity transitions (e.g. removing an absent attr key) commit
          // without changing state — the diff is rightly empty.
          expect(canonical(space)).toBe(canonical(target));
          return;
        }
        const replayed = applyDelta(space, delta);
        expect(replayed.ok, !replayed.ok ? JSON.stringify(replayed.errors) : '').toBe(true);
        if (replayed.ok) expect(canonical(replayed.space)).toBe(canonical(target));
      }),
    );
  });
});

describe('subscriptions under random commit counts', () => {
  it('exactly one in-order batch per commit', async () => {
    await fc.assert(
      fc.asyncProperty(mutationCaseArb, async ({ space, ops }) => {
        const store = createStore(space);
        const seen: ChangeSet[] = [];
        store.subscribe((c) => seen.push(c));
        let commits = 0;
        for (const op of ops) {
          const r = store.apply({ origin: ORIGIN, ops: [op] });
          expect(r.ok).toBe(true);
          commits++;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(seen).toHaveLength(commits);
        seen.forEach((c, i) => {
          expect(c.fromVersion.counter).toBe(i);
          expect(c.toVersion.counter).toBe(i + 1);
          expect(c.ops).toHaveLength(1);
        });
      }),
      { numRuns: 25 },
    );
  });
});

// ----------------------------------------------------------------- helpers

function isSorted(ids: readonly string[]): boolean {
  return ids.every((id, i) => i === 0 || ids[i - 1]! <= id);
}

function allNodes(space: GraphSpace): Array<{ graph: string; node: SemanticNode }> {
  return [...space.graphs.values()].flatMap((g) =>
    [...g.nodes.values()].map((node) => ({ graph: String(g.id), node })),
  );
}
