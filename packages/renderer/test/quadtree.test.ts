import { describe, expect, it } from 'vitest';
import {
  buildQuadtree,
  QUADTREE_CAPACITY,
  QUADTREE_MAX_DEPTH,
  queryQuadtree,
  queryQuadtreeWithStats,
  type Aabb,
  type QuadtreeItem,
} from '../src/quadtree.js';

function box(minX: number, minY: number, maxX: number, maxY: number): Aabb {
  return { minX, minY, maxX, maxY };
}

function item(index: number, bounds: Aabb): QuadtreeItem {
  return { index, bounds };
}

describe('world-space quadtree', () => {
  it('publishes the ADR defaults and supports a zero-node model', () => {
    expect(QUADTREE_CAPACITY).toBe(16);
    expect(QUADTREE_MAX_DEPTH).toBe(12);

    const tree = buildQuadtree([]);
    expect(tree.nodeBounds).toHaveLength(0);
    expect(tree.childOffsets).toHaveLength(0);
    expect(tree.itemOffsets).toEqual(new Uint32Array([0]));
    expect(tree.itemIndices).toHaveLength(0);
    expect(tree.itemBounds).toHaveLength(0);
    expect(queryQuadtree(tree, box(-10, -10, 10, 10))).toEqual(new Uint32Array());
  });

  it('exact-filters candidates and treats touching AABB boundaries as intersections', () => {
    const tree = buildQuadtree([
      item(7, box(0, 0, 4, 4)),
      item(2, box(8, 8, 10, 10)),
      item(9, box(4, 4, 4, 4)),
    ]);

    expect(queryQuadtree(tree, box(4, 4, 6, 6))).toEqual(new Uint32Array([7, 9]));
    expect(queryQuadtree(tree, box(4.000_001, 4.000_001, 6, 6))).toEqual(
      new Uint32Array(),
    );
    expect(queryQuadtreeWithStats(tree, box(4, 4, 6, 6))).toEqual({
      indices: new Uint32Array([7, 9]),
      candidateCount: 3,
    });
  });

  it('splits in NW/NE/SW/SE order and retains cross-boundary entries in the parent', () => {
    const entries = [
      item(9, box(4, 2, 6, 3)),
      item(4, box(1, 1, 2, 2)),
      item(3, box(8, 1, 9, 2)),
      item(2, box(1, 8, 2, 9)),
      item(1, box(8, 8, 9, 9)),
    ];
    const tree = buildQuadtree(entries, { capacity: 1, maxDepth: 1 });

    expect(tree.childOffsets).toEqual(new Int32Array([1, -1, -1, -1, -1]));
    expect([...tree.nodeBounds]).toEqual([
      1, 1, 9, 9,
      1, 1, 5, 5,
      5, 1, 9, 5,
      1, 5, 5, 9,
      5, 5, 9, 9,
    ]);
    expect(tree.itemOffsets).toEqual(new Uint32Array([0, 1, 2, 3, 4, 5]));
    expect(tree.itemIndices).toEqual(new Uint32Array([9, 4, 3, 2, 1]));
    expect(queryQuadtree(tree, box(0, 0, 10, 10))).toEqual(
      new Uint32Array([1, 2, 3, 4, 9]),
    );
    expect(queryQuadtree(tree, box(8.5, 1.5, 8.5, 1.5))).toEqual(new Uint32Array([3]));
    expect(queryQuadtree(tree, box(5.5, 2.5, 5.5, 2.5))).toEqual(new Uint32Array([9]));
  });

  it('has byte-identical packed output for every caller insertion order', () => {
    const ordered = [
      item(0, box(-9, -9, -8, -8)),
      item(1, box(8, -9, 9, -8)),
      item(2, box(-9, 8, -8, 9)),
      item(3, box(8, 8, 9, 9)),
      item(4, box(-1, -1, 1, 1)),
    ];
    const reversed = [...ordered].reverse();
    const a = buildQuadtree(ordered, { capacity: 1 });
    const b = buildQuadtree(reversed, { capacity: 1 });

    expect(b.nodeBounds).toEqual(a.nodeBounds);
    expect(b.childOffsets).toEqual(a.childOffsets);
    expect(b.itemOffsets).toEqual(a.itemOffsets);
    expect(b.itemIndices).toEqual(a.itemIndices);
    expect(b.itemBounds).toEqual(a.itemBounds);
  });

  it('honors max depth and terminates on degenerate world bounds', () => {
    const clustered = Array.from({ length: 20 }, (_, index) =>
      item(index, box(index / 100, index / 100, index / 100, index / 100)),
    );
    const shallow = buildQuadtree(clustered, { capacity: 1, maxDepth: 1 });
    expect(shallow.childOffsets).toHaveLength(5);
    expect(shallow.childOffsets.slice(1)).toEqual(new Int32Array([-1, -1, -1, -1]));

    const coincident = buildQuadtree(
      Array.from({ length: 20 }, (_, index) => item(index, box(5, 5, 5, 5))),
      { capacity: 1 },
    );
    expect(coincident.childOffsets).toEqual(new Int32Array([-1]));
    expect(queryQuadtree(coincident, box(5, 5, 5, 5))).toHaveLength(20);
  });

  it('rejects invalid indices, bounds, queries, and options', () => {
    expect(() => buildQuadtree([item(-1, box(0, 0, 1, 1))])).toThrow('uint32');
    expect(() => buildQuadtree([item(0, box(2, 0, 1, 1))])).toThrow(
      'non-negative extents',
    );
    expect(() => buildQuadtree([], { capacity: 0 })).toThrow('positive safe integer');
    expect(() => buildQuadtree([], { maxDepth: -1 })).toThrow('non-negative safe integer');
    expect(() => queryQuadtree(buildQuadtree([]), box(0, 0, Number.NaN, 1))).toThrow(
      'finite',
    );
  });
});
