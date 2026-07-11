/**
 * `elk-layered` provider unit tests (ROADMAP Phase 4 §3, §9, §12; subphase 4D):
 * providers on tiny graphs vs hand-computed truth, compound nesting, optional
 * orthogonal routes, determinism (I6), position-hint stability (ADR-0016), and
 * the degenerate inputs the verification table names (zero-size nodes,
 * disconnected components, empty cut).
 */
import { describe, expect, it } from 'vitest';
import { elkLayeredProvider as elk, type CompoundNesting, type LayoutInput, type LayoutResult, type Rect } from '../src/index.js';
import { cutOf, edge, n, rectOf, sizes, uniformSizes } from './helpers.js';

function centersEqualJson(r: LayoutResult): string {
  const pos = [...r.positions].map(([k, v]) => [String(k), v.x, v.y, v.width, v.height]);
  const routes = r.edgeRoutes ? [...r.edgeRoutes].map(([k, p]) => [k, p.map((q) => [q.x, q.y])]) : [];
  return JSON.stringify({ pos, routes, bounds: r.bounds, stability: r.stability });
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

const chain: LayoutInput = {
  cut: cutOf('a', 'b', 'c', 'd'),
  edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')],
  sizes: uniformSizes(['a', 'b', 'c', 'd'], { width: 60, height: 24 }),
  hints: { direction: 'down', spacing: 20 },
};

describe('elk-layered — capabilities & basics', () => {
  it('declares incremental, compound, deterministic', () => {
    expect(elk.capabilities).toEqual({ incremental: true, compound: true, deterministic: true });
    expect(elk.id).toBe('elk-layered');
  });

  it('empty cut → empty result, vacuously stable', async () => {
    const r = await elk.compute({ cut: cutOf(), edges: [], sizes: new Map(), hints: {} });
    expect(r.positions.size).toBe(0);
    expect(r.bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(r.stability).toBe(1);
  });

  it('places every member with its input size, never inventing sizes (ADR-0015)', async () => {
    const r = await elk.compute(chain);
    expect(r.positions.size).toBe(4);
    for (const id of ['a', 'b', 'c', 'd']) {
      const rect = rectOf(r.positions, id);
      expect(rect.width).toBe(60);
      expect(rect.height).toBe(24);
      expect(Number.isFinite(rect.x) && Number.isFinite(rect.y)).toBe(true);
    }
  });
});

describe('elk-layered — layering & no overlap (hand-computed truth)', () => {
  it("a→b→c→d in 'down' lays out monotonically increasing y (layers flow down)", async () => {
    const r = await elk.compute(chain);
    const cy = (id: string) => rectOf(r.positions, id).y;
    expect(cy('a')).toBeLessThan(cy('b'));
    expect(cy('b')).toBeLessThan(cy('c'));
    expect(cy('c')).toBeLessThan(cy('d'));
  });

  it('no two member boxes overlap', async () => {
    const r = await elk.compute({
      cut: cutOf('r', 'x', 'y', 'z'),
      edges: [edge('r', 'x'), edge('r', 'y'), edge('r', 'z')],
      sizes: uniformSizes(['r', 'x', 'y', 'z'], { width: 50, height: 20 }),
      hints: { spacing: 16 },
    });
    const ids = ['r', 'x', 'y', 'z'];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        expect(overlaps(rectOf(r.positions, ids[i]!), rectOf(r.positions, ids[j]!))).toBe(false);
      }
    }
  });
});

describe('elk-layered — orthogonal edge routes', () => {
  it('emits an orthogonal polyline per induced edge, keyed by "src→dst→kind"', async () => {
    const r = await elk.compute(chain);
    expect(r.edgeRoutes).toBeDefined();
    expect(r.edgeRoutes!.size).toBe(3);
    for (const e of chain.edges) {
      const key = `${e.src}→${e.dst}→${e.kind}`;
      const poly = r.edgeRoutes!.get(key);
      expect(poly, `route for ${key}`).toBeDefined();
      expect(poly!.length).toBeGreaterThanOrEqual(2);
      for (const p of poly!) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    }
  });

  it('bounds enclose every route point (ADR-0015)', async () => {
    const r = await elk.compute(chain);
    const b = r.bounds;
    for (const poly of r.edgeRoutes!.values()) {
      for (const p of poly) {
        expect(p.x).toBeGreaterThanOrEqual(b.x - 1e-6);
        expect(p.x).toBeLessThanOrEqual(b.x + b.width + 1e-6);
        expect(p.y).toBeGreaterThanOrEqual(b.y - 1e-6);
        expect(p.y).toBeLessThanOrEqual(b.y + b.height + 1e-6);
      }
    }
  });
});

describe('elk-layered — compound nesting', () => {
  const compound: CompoundNesting = {
    groupOf: new Map([
      [n('a'), 'G0'],
      [n('b'), 'G0'],
      [n('c'), 'G1'],
      [n('d'), 'G1'],
    ]),
    parentOf: new Map(),
  };
  const compoundInput: LayoutInput = {
    cut: cutOf('a', 'b', 'c', 'd'),
    edges: [edge('a', 'b'), edge('c', 'd'), edge('a', 'c')],
    sizes: uniformSizes(['a', 'b', 'c', 'd'], { width: 60, height: 24 }),
    hints: { spacing: 20 },
    compound,
  };

  it('returns positions only for members — synthetic containers are not members', async () => {
    const r = await elk.compute(compoundInput);
    expect([...r.positions.keys()].map(String).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('groups each container tightly: same-group members are nearer than cross-group', async () => {
    const r = await elk.compute(compoundInput);
    const c = (id: string) => {
      const rect = rectOf(r.positions, id);
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    };
    const dist = (p: string, q: string) => Math.hypot(c(p).x - c(q).x, c(p).y - c(q).y);
    // a,b share G0; c,d share G1. Intra-group spacing must beat the cross-group span.
    expect(dist('a', 'b')).toBeLessThan(dist('a', 'd'));
    expect(dist('c', 'd')).toBeLessThan(dist('b', 'c') + dist('a', 'd'));
  });

  it('compound nesting changes the layout vs the flat version', async () => {
    const flat = await elk.compute({ ...compoundInput, compound: undefined });
    const nested = await elk.compute(compoundInput);
    expect(centersEqualJson(flat)).not.toBe(centersEqualJson(nested));
  });
});

describe('elk-layered — determinism (I6)', () => {
  it('two runs of the same input are byte-identical (positions + routes)', async () => {
    const a = await elk.compute(chain);
    const b = await elk.compute(chain);
    expect(centersEqualJson(a)).toBe(centersEqualJson(b));
  });

  it('compound runs are byte-identical too', async () => {
    const input: LayoutInput = {
      cut: cutOf('a', 'b', 'c', 'd', 'e', 'f'),
      edges: [edge('a', 'b'), edge('c', 'd'), edge('e', 'f'), edge('a', 'c'), edge('c', 'e')],
      sizes: uniformSizes(['a', 'b', 'c', 'd', 'e', 'f'], { width: 40, height: 20 }),
      hints: { spacing: 12 },
      compound: {
        groupOf: new Map([
          [n('a'), 'G0'],
          [n('b'), 'G0'],
          [n('c'), 'G1'],
          [n('d'), 'G1'],
          [n('e'), 'G2'],
          [n('f'), 'G2'],
        ]),
        parentOf: new Map([['G1', 'G0']]), // G1 nested inside G0
      },
    };
    const a = await elk.compute(input);
    const b = await elk.compute(input);
    expect(centersEqualJson(a)).toBe(centersEqualJson(b));
  });
});

describe('elk-layered — degenerate inputs (verification table)', () => {
  it('zero-size nodes place as point-rects (width/height 0 preserved)', async () => {
    const r = await elk.compute({
      cut: cutOf('a', 'b'),
      edges: [edge('a', 'b')],
      sizes: sizes({ a: { width: 0, height: 0 }, b: { width: 40, height: 20 } }),
      hints: {},
    });
    const a = rectOf(r.positions, 'a');
    expect(a.width).toBe(0);
    expect(a.height).toBe(0);
    expect(Number.isFinite(a.x) && Number.isFinite(a.y)).toBe(true);
  });

  it('disconnected components: all members placed, no NaN', async () => {
    const r = await elk.compute({
      cut: cutOf('a', 'b', 'x', 'y', 'z'),
      edges: [edge('a', 'b'), edge('x', 'y')], // {a,b}, {x,y}, {z}
      sizes: uniformSizes(['a', 'b', 'x', 'y', 'z'], { width: 50, height: 20 }),
      hints: { spacing: 16 },
    });
    expect(r.positions.size).toBe(5);
    for (const id of ['a', 'b', 'x', 'y', 'z']) {
      const rect = rectOf(r.positions, id);
      expect(Number.isFinite(rect.x) && Number.isFinite(rect.y)).toBe(true);
    }
  });
});

describe('elk-layered — position hints (ADR-0016 stability mechanism)', () => {
  it('a small delta keeps persistent nodes near their prior spots (stability ≥ 0.90)', async () => {
    const base: LayoutInput = {
      cut: cutOf('a', 'b', 'c', 'd', 'e', 'f'),
      edges: [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'e'), edge('d', 'f'), edge('e', 'f')],
      sizes: uniformSizes(['a', 'b', 'c', 'd', 'e', 'f'], { width: 50, height: 24 }),
      hints: { direction: 'down', spacing: 20 },
    };
    const prev = await elk.compute(base);
    // Add one leaf 'g' under f — a small delta.
    const next: LayoutInput = {
      ...base,
      cut: cutOf('a', 'b', 'c', 'd', 'e', 'f', 'g'),
      edges: [...base.edges, edge('f', 'g')],
      sizes: uniformSizes(['a', 'b', 'c', 'd', 'e', 'f', 'g'], { width: 50, height: 24 }),
    };
    const withHints = await elk.compute(next, prev);
    expect(withHints.stability).toBeGreaterThanOrEqual(0.9);
  });

  it('first-ever layout (no prev) is vacuously stable = 1', async () => {
    const r = await elk.compute(chain);
    expect(r.stability).toBe(1);
  });
});
