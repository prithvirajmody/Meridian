/**
 * The `d3-force` provider (ROADMAP Phase 4 §3, §9; subphase 4E). This suite
 * pins the four contracts the roadmap makes tests, not hopes:
 *
 * - **Seeded determinism (I6; §9b).** Same input ⇒ byte-identical positions;
 *   the same input under a *different* seed generally differs (the seed is
 *   live), but each seed is itself reproducible.
 * - **Warm-start stability (ADR-0016).** A scripted small-delta sequence,
 *   warm-started from the previous result, stays ≥ 0.90 — the same floor the
 *   CI benchmark gates, asserted here on hand-built inputs.
 * - **Cooperative cancellation (ADR-0017).** A pre-aborted (or mid-run) signal
 *   makes `compute` reject with an `AbortError`.
 * - **Totality (ADR-0015).** Empty cut, single node, disconnected components,
 *   and zero-size nodes all produce finite positions.
 */
import { describe, expect, it } from 'vitest';
import { d3ForceProvider, stabilityScore, type LayoutInput, type LayoutResult } from '../src/index.js';
import { cutOf, edge, n, uniformSizes } from './helpers.js';

const box = { width: 44, height: 22 };

function serialize(r: LayoutResult): string {
  return JSON.stringify([...r.positions.entries()].map(([id, rect]) => [String(id), rect]));
}

function allFinite(r: LayoutResult): boolean {
  for (const rect of r.positions.values()) {
    if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y)) return false;
  }
  return Number.isFinite(r.bounds.x) && Number.isFinite(r.bounds.width);
}

const clustered: () => LayoutInput = () => ({
  cut: cutOf('a', 'b', 'c', 'd', 'e', 'f'),
  // two triangles joined by one bridge — a tangled, cluster-ish shape
  edges: [
    edge('a', 'b'),
    edge('b', 'c'),
    edge('c', 'a'),
    edge('d', 'e'),
    edge('e', 'f'),
    edge('f', 'd'),
    edge('c', 'd'),
  ],
  sizes: uniformSizes(['a', 'b', 'c', 'd', 'e', 'f'], box),
  hints: { spacing: 20 },
});

describe('d3-force — seeded determinism (I6)', () => {
  it('same input → byte-identical positions', async () => {
    const input = clustered();
    const r1 = await d3ForceProvider.compute(input);
    const r2 = await d3ForceProvider.compute(input);
    expect(serialize(r1)).toBe(serialize(r2));
    expect(r1.bounds).toEqual(r2.bounds);
  });

  it('an explicit seed is reproducible and generally distinct from another seed', async () => {
    const base = clustered();
    const withSeed = (seed: number): LayoutInput => ({ ...base, hints: { ...base.hints, seed } });
    const a1 = await d3ForceProvider.compute(withSeed(1));
    const a2 = await d3ForceProvider.compute(withSeed(1));
    const b = await d3ForceProvider.compute(withSeed(2));
    expect(serialize(a1)).toBe(serialize(a2)); // seed 1 reproducible
    expect(serialize(a1)).not.toBe(serialize(b)); // different seed → different layout
  });

  it('declares itself deterministic and incremental, not compound', () => {
    expect(d3ForceProvider.capabilities).toEqual({ incremental: true, compound: false, deterministic: true });
    expect(d3ForceProvider.id).toBe('d3-force');
  });
});

describe('d3-force — warm-start stability (ADR-0016) ≥ 0.90 on small deltas', () => {
  it('a scripted small-delta sequence stays above the floor', async () => {
    // Start from a ring of 8 nodes, then add ≤ 2 leaves per step (a small
    // delta, ADR-0016), warm-starting each step from the previous result.
    const ringIds = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'];
    const ringEdges = ringIds.map((id, i) => edge(id, ringIds[(i + 1) % ringIds.length]!));
    const ids = [...ringIds];
    const edges = [...ringEdges];
    const hints = { spacing: 20 };

    let prev = await d3ForceProvider.compute({ cut: cutOf(...ids), edges, sizes: uniformSizes(ids, box), hints });
    const scores: number[] = [];
    for (let step = 0; step < 5; step++) {
      const leaf = `s${step}`;
      const anchor = ids[step % ringIds.length]!;
      ids.push(leaf);
      edges.push(edge(anchor, leaf));
      const next: LayoutInput = { cut: cutOf(...ids), edges, sizes: uniformSizes(ids, box), hints };
      const out = await d3ForceProvider.compute(next, prev);
      // The reported score equals an independent recomputation (no self-lie).
      const recomputed = stabilityScore(prev, out, hints).stability;
      expect(out.stability).toBeCloseTo(recomputed, 12);
      scores.push(out.stability);
      prev = out;
    }
    const min = Math.min(...scores);
    expect(min).toBeGreaterThanOrEqual(0.9);
  });

  it('a first-ever layout reports stability 1 (no prev to teleport from)', async () => {
    const out = await d3ForceProvider.compute(clustered());
    expect(out.stability).toBe(1);
  });
});

describe('d3-force — cooperative cancellation (ADR-0017)', () => {
  it('rejects with AbortError when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(d3ForceProvider.compute(clustered(), undefined, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('rejects with AbortError when aborted during the tick loop', async () => {
    // A larger graph so the tick loop runs long enough to observe a mid-run
    // abort fired on the next microtask.
    const ids = Array.from({ length: 400 }, (_, i) => `x${String(i).padStart(3, '0')}`);
    const edges = ids.slice(1).map((id, i) => edge(ids[i]!, id));
    const input: LayoutInput = { cut: cutOf(...ids), edges, sizes: uniformSizes(ids, box), hints: { spacing: 20 } };
    const controller = new AbortController();
    const p = d3ForceProvider.compute(input, undefined, controller.signal);
    controller.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('d3-force — totality (ADR-0015)', () => {
  it('empty cut → empty positions, vacuous stability', async () => {
    const out = await d3ForceProvider.compute({ cut: cutOf(), edges: [], sizes: new Map(), hints: {} });
    expect(out.positions.size).toBe(0);
    expect(out.stability).toBe(1);
    expect(out.bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it('single node → finite position', async () => {
    const out = await d3ForceProvider.compute({ cut: cutOf('solo'), edges: [], sizes: uniformSizes(['solo'], box), hints: {} });
    expect(out.positions.size).toBe(1);
    expect(allFinite(out)).toBe(true);
  });

  it('disconnected components and zero-size nodes stay finite', async () => {
    const ids = ['a', 'b', 'c', 'z'];
    const input: LayoutInput = {
      cut: cutOf(...ids),
      edges: [edge('a', 'b'), edge('b', 'c')], // {a,b,c} + isolated z
      sizes: new Map([
        [n('a'), box],
        [n('b'), box],
        [n('c'), box],
        [n('z'), { width: 0, height: 0 }],
      ]),
      hints: { spacing: 20 },
    };
    const out = await d3ForceProvider.compute(input);
    expect(out.positions.size).toBe(4);
    expect(allFinite(out)).toBe(true);
  });

  it('omits edgeRoutes (straight center-to-center lines, §9c)', async () => {
    const out = await d3ForceProvider.compute(clustered());
    expect(out.edgeRoutes).toBeUndefined();
  });
});
