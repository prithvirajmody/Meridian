/**
 * Grid and tree providers vs hand-computed truth (ROADMAP 4B test list):
 * tiny graphs with the exact expected geometry, zero-size nodes as point-rects
 * (ADR-0015), disconnected-component shelf-packing (ADR-0015), and byte-level
 * determinism (I6). Cell pitch is `size + hints.spacing`; default spacing is
 * `DEFAULT_SPACING` (24) unless a test sets `hints.spacing`.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SPACING, gridProvider, treeProvider, type LayoutInput } from '../src/index.js';
import { cutOf, edge, n, rectOf, sizes, uniformSizes } from './helpers.js';

const S = DEFAULT_SPACING; // 24
const box = { width: 40, height: 20 };

describe('grid provider — hand-computed truth', () => {
  it('single node sits at the origin with its own size', async () => {
    const input: LayoutInput = { cut: cutOf('a'), edges: [], sizes: sizes({ a: box }), hints: {} };
    const { positions, bounds } = await gridProvider.compute(input);
    expect(rectOf(positions, 'a')).toEqual({ x: 0, y: 0, width: 40, height: 20 });
    expect(bounds).toEqual({ x: 0, y: 0, width: 40, height: 20 });
  });

  it('a connected 4-node component packs into a 2×2 grid', async () => {
    // a-b-c-d chain → one component; ceil(sqrt(4)) = 2 columns; pitch 40+24=64 / 20+24=44.
    const input: LayoutInput = {
      cut: cutOf('a', 'b', 'c', 'd'),
      edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')],
      sizes: uniformSizes(['a', 'b', 'c', 'd'], box),
      hints: {},
    };
    const { positions, bounds } = await gridProvider.compute(input);
    expect(rectOf(positions, 'a')).toEqual({ x: 0, y: 0, width: 40, height: 20 });
    expect(rectOf(positions, 'b')).toEqual({ x: 64, y: 0, width: 40, height: 20 });
    expect(rectOf(positions, 'c')).toEqual({ x: 0, y: 44, width: 40, height: 20 });
    expect(rectOf(positions, 'd')).toEqual({ x: 64, y: 44, width: 40, height: 20 });
    expect(bounds).toEqual({ x: 0, y: 0, width: 104, height: 64 });
  });

  it('two disconnected singletons shelf-pack (equal area → ascending NodeId)', async () => {
    // limit = max(width 40, sqrt(2·800)=40) = 40, so b wraps below a (gap 24).
    const input: LayoutInput = {
      cut: cutOf('a', 'b'),
      edges: [],
      sizes: uniformSizes(['a', 'b'], box),
      hints: {},
    };
    const { positions, bounds } = await gridProvider.compute(input);
    expect(rectOf(positions, 'a')).toEqual({ x: 0, y: 0, width: 40, height: 20 });
    expect(rectOf(positions, 'b')).toEqual({ x: 0, y: 20 + S, width: 40, height: 20 });
    expect(bounds).toEqual({ x: 0, y: 0, width: 40, height: 64 });
  });

  it('zero-size nodes become degenerate point-rects, still separated', async () => {
    const input: LayoutInput = {
      cut: cutOf('a', 'b'),
      edges: [],
      sizes: uniformSizes(['a', 'b'], { width: 0, height: 0 }),
      hints: {},
    };
    const { positions, bounds } = await gridProvider.compute(input);
    expect(rectOf(positions, 'a')).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(rectOf(positions, 'b')).toEqual({ x: 0, y: S, width: 0, height: 0 });
    expect(bounds).toEqual({ x: 0, y: 0, width: 0, height: S });
  });

  it('empty cut → empty positions and {0,0,0,0} bounds', async () => {
    const input: LayoutInput = { cut: cutOf(), edges: [], sizes: sizes({}), hints: {} };
    const { positions, bounds, stability } = await gridProvider.compute(input);
    expect(positions.size).toBe(0);
    expect(bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(stability).toBe(1);
  });

  it('every coordinate is finite', async () => {
    const input: LayoutInput = {
      cut: cutOf('a', 'b', 'c'),
      edges: [edge('a', 'b')],
      sizes: uniformSizes(['a', 'b', 'c'], box),
      hints: {},
    };
    const { positions, bounds } = await gridProvider.compute(input);
    for (const r of positions.values()) {
      for (const v of [r.x, r.y, r.width, r.height]) expect(Number.isFinite(v)).toBe(true);
    }
    for (const v of [bounds.x, bounds.y, bounds.width, bounds.height]) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('tree provider — hand-computed truth', () => {
  it('a root over two leaves centers the parent (down direction)', async () => {
    // r→a, r→b; leaves a,b get slots 0,1; r centers at 0.5. Pitch 64 / 44.
    const input: LayoutInput = {
      cut: cutOf('r', 'a', 'b'),
      edges: [edge('r', 'a'), edge('r', 'b')],
      sizes: uniformSizes(['r', 'a', 'b'], box),
      hints: {},
    };
    const { positions, bounds } = await treeProvider.compute(input);
    expect(rectOf(positions, 'a')).toEqual({ x: 0, y: 44, width: 40, height: 20 });
    expect(rectOf(positions, 'b')).toEqual({ x: 64, y: 44, width: 40, height: 20 });
    expect(rectOf(positions, 'r')).toEqual({ x: 32, y: 0, width: 40, height: 20 });
    expect(bounds).toEqual({ x: 0, y: 0, width: 104, height: 64 });
  });

  it("'right' direction transposes depth↔breadth axes", async () => {
    const input: LayoutInput = {
      cut: cutOf('r', 'a', 'b'),
      edges: [edge('r', 'a'), edge('r', 'b')],
      sizes: uniformSizes(['r', 'a', 'b'], box),
      hints: { direction: 'right' },
    };
    const { positions } = await treeProvider.compute(input);
    // 'right': x = depth·(colW+24)=64 per layer; y = slot·(rowH+24)=44 per slot.
    expect(rectOf(positions, 'r')).toEqual({ x: 0, y: 22, width: 40, height: 20 });
    expect(rectOf(positions, 'a')).toEqual({ x: 64, y: 0, width: 40, height: 20 });
    expect(rectOf(positions, 'b')).toEqual({ x: 64, y: 44, width: 40, height: 20 });
  });

  it('a purely cyclic component roots at its minimum member', async () => {
    // a→b→c→a: no indegree-0 node; root = a (min). a depth0, b depth1, c depth2.
    const input: LayoutInput = {
      cut: cutOf('a', 'b', 'c'),
      edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')],
      sizes: uniformSizes(['a', 'b', 'c'], box),
      hints: {},
    };
    const { positions } = await treeProvider.compute(input);
    expect(rectOf(positions, 'a').y).toBe(0);
    expect(rectOf(positions, 'b').y).toBe(44);
    expect(rectOf(positions, 'c').y).toBe(88);
  });

  it('disconnected trees shelf-pack as whole components', async () => {
    // Two identical 1→2 trees: {a→a1,a2} and {b→b1,b2}. Equal area, a-comp first.
    const ids = ['a', 'a1', 'a2', 'b', 'b1', 'b2'];
    const input: LayoutInput = {
      cut: cutOf(...ids),
      edges: [edge('a', 'a1'), edge('a', 'a2'), edge('b', 'b1'), edge('b', 'b2')],
      sizes: uniformSizes(ids, box),
      hints: {},
    };
    const { positions } = await treeProvider.compute(input);
    // Within each component the local geometry is identical; the b-component is
    // offset from the a-component (never overlapping) — assert disjoint x-or-y.
    const a = rectOf(positions, 'a');
    const b = rectOf(positions, 'b');
    const overlapX = a.x < b.x + 104 && b.x < a.x + 104;
    const overlapY = a.y < b.y + 64 && b.y < a.y + 64;
    expect(overlapX && overlapY).toBe(false);
  });
});

describe('determinism (I6)', () => {
  it('grid: same input → byte-identical positions', async () => {
    const mk = (): LayoutInput => ({
      cut: cutOf('a', 'b', 'c', 'd'),
      edges: [edge('a', 'b'), edge('c', 'd')],
      sizes: uniformSizes(['a', 'b', 'c', 'd'], box),
      hints: {},
    });
    const r1 = await gridProvider.compute(mk());
    const r2 = await gridProvider.compute(mk());
    expect([...r1.positions]).toEqual([...r2.positions]);
    expect(r1.bounds).toEqual(r2.bounds);
  });

  it('tree: edge insertion order does not change output', async () => {
    const base = { cut: cutOf('r', 'a', 'b', 'c'), sizes: uniformSizes(['r', 'a', 'b', 'c'], box), hints: {} };
    const r1 = await treeProvider.compute({ ...base, edges: [edge('r', 'a'), edge('r', 'b'), edge('r', 'c')] });
    const r2 = await treeProvider.compute({ ...base, edges: [edge('r', 'c'), edge('r', 'a'), edge('r', 'b')] });
    expect([...r1.positions]).toEqual([...r2.positions]);
  });

  it('positions map is keyed in ascending NodeId order', async () => {
    const input: LayoutInput = {
      cut: cutOf('d', 'a', 'c', 'b'),
      edges: [],
      sizes: uniformSizes(['a', 'b', 'c', 'd'], box),
      hints: {},
    };
    const { positions } = await gridProvider.compute(input);
    const keys = [...positions.keys()];
    expect(keys).toEqual([n('a'), n('b'), n('c'), n('d')]);
  });
});
