/**
 * Worker wire-protocol unit tests (ADR-0017): the typed-array encode/decode is
 * pure and main-thread-testable, so the exact bytes that cross the boundary are
 * asserted here without spawning a worker. Covers the request/response
 * encodings, the order-preserving placeholder ids (the property that makes
 * in-worker grid/tree byte-identical to main-thread), prev warm-start
 * encoding, the CSR edge-route encoding, and the lazy array-backed result view.
 */
import { describe, expect, it } from 'vitest';
import type { Point, Rect } from '../src/index.js';
import {
  buildIndexTable,
  decodeRequest,
  decodeResponse,
  decodeResponseLazy,
  encodeRequest,
  encodeResponse,
  gridProvider,
  placeholderId,
  type LayoutInput,
  type LayoutResult,
} from '../src/index.js';
import { cutOf, edge, n, rectOf, sizes } from './helpers.js';

function smallInput(): LayoutInput {
  return {
    cut: cutOf('a', 'b', 'c', 'd'),
    edges: [edge('a', 'b'), edge('b', 'c', 'rel:y')],
    sizes: sizes({
      a: { width: 60, height: 28 },
      b: { width: 80, height: 30 },
      c: { width: 40, height: 20 },
      d: { width: 0, height: 0 },
    }),
    hints: { spacing: 12 },
  };
}

const rectEq = (a: Rect, b: Rect): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

describe('index table & placeholder ids (ADR-0017 node index space)', () => {
  it('placeholder ids sort identically to member index order', () => {
    const table = buildIndexTable(cutOf(...Array.from({ length: 123 }, (_, i) => `node-${i}`)).members);
    const placeholders = table.ids.map((_, i) => String(placeholderId(i, table.width)));
    const sorted = [...placeholders].sort();
    expect(placeholders).toEqual(sorted); // lexicographic order === index order
    expect(table.width).toBe(3); // ceil(log10(122)) → 3-wide
  });

  it('index ↔ NodeId table is the ascending member list', () => {
    const table = buildIndexTable(cutOf('c', 'a', 'b').members);
    expect(table.ids.map(String)).toEqual(['a', 'b', 'c']);
    expect(table.index.get(n('b'))).toBe(1);
  });
});

describe('request encode/decode (ADR-0017 request table)', () => {
  it('round-trips sizes, edges, kinds and hints into placeholder space', () => {
    const input = smallInput();
    const table = buildIndexTable(input.cut.members);
    const req = encodeRequest(7, 'grid', input, table);
    expect(req.N).toBe(4);
    expect(req.requestId).toBe(7);
    expect(Array.from(req.sizes)).toEqual([60, 28, 80, 30, 40, 20, 0, 0]);
    // two edges, interned kinds
    expect(req.edgeWeights.length).toBe(2);
    expect(req.kindTable).toEqual(['rel:x', 'rel:y']);
    expect(req.parents.every((p) => p === -1)).toBe(true);

    const { input: decoded, prev } = decodeRequest(req);
    expect(prev).toBeUndefined();
    expect(decoded.cut.members.map(String)).toEqual(['0', '1', '2', '3']);
    expect(decoded.edges).toHaveLength(2);
    expect(decoded.edges[0]!.kind).toBe('rel:x');
    expect(decoded.sizes.get(placeholderId(1, table.width))).toEqual({ width: 80, height: 30 });
  });

  it('prev positions round-trip with a presence mask (warm start)', () => {
    const input = smallInput();
    const table = buildIndexTable(input.cut.members);
    // prev present only for a and c
    const prev: LayoutResult = {
      positions: new Map([
        [n('a'), { x: 1, y: 2, width: 60, height: 28 }],
        [n('c'), { x: 5, y: 6, width: 40, height: 20 }],
      ]),
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      stability: 1,
    };
    const req = encodeRequest(1, 'grid', input, table, prev);
    expect(req.hasPrev).toBe(true);
    expect(Array.from(req.prevMask)).toEqual([1, 0, 1, 0]);
    const { prev: decodedPrev } = decodeRequest(req);
    expect(decodedPrev).toBeDefined();
    expect(decodedPrev!.positions.size).toBe(2);
    expect(decodedPrev!.positions.get(placeholderId(0, table.width))).toEqual({ x: 1, y: 2, width: 60, height: 28 });
  });
});

describe('response encode/decode (ADR-0017 response table)', () => {
  it('round-trips positions, bounds and stability', async () => {
    const input = smallInput();
    const table = buildIndexTable(input.cut.members);
    const { input: workerInput } = decodeRequest(encodeRequest(1, 'grid', input, table));
    const result = await gridProvider.compute(workerInput);
    const res = encodeResponse(1, result, workerInput);
    expect(res.positions.length).toBe(4 * 4);

    const decoded = decodeResponse(res, table, input.edges);
    expect(decoded.stability).toBe(result.stability);
    expect(rectEq(decoded.bounds, result.bounds)).toBe(true);
    for (const id of input.cut.members) {
      const got = decoded.positions.get(id)!;
      const want = result.positions.get(placeholderId(table.index.get(id)!, table.width))!;
      expect(rectEq(got, want)).toBe(true);
    }
  });

  it('encodes edge routes as CSR and re-keys them by real "src→dst→kind"', () => {
    const input = smallInput();
    const table = buildIndexTable(input.cut.members);
    const { input: workerInput } = decodeRequest(encodeRequest(1, 'grid', input, table));
    // A synthetic routed result over placeholder ids.
    const route: Point[] = [
      { x: 0, y: 0 },
      { x: 5, y: 9 },
      { x: 10, y: 0 },
    ];
    const routedKey = `${workerInput.edges[0]!.src}→${workerInput.edges[0]!.dst}→${workerInput.edges[0]!.kind}`;
    const positions = new Map<string, Rect>();
    for (const m of workerInput.cut.members) positions.set(m, { x: 0, y: 0, width: 1, height: 1 });
    const result: LayoutResult = {
      positions: positions as unknown as LayoutResult['positions'],
      edgeRoutes: new Map([[routedKey, route]]),
      bounds: { x: 0, y: 0, width: 10, height: 9 },
      stability: 1,
    };
    const res = encodeResponse(1, result, workerInput);
    const decoded = decodeResponse(res, table, input.edges);
    const realKey = `${input.edges[0]!.src}→${input.edges[0]!.dst}→${input.edges[0]!.kind}`;
    expect(decoded.edgeRoutes?.get(realKey)).toEqual(route);
    // the un-routed second edge is absent
    expect(decoded.edgeRoutes?.size).toBe(1);
  });

  it('lazy array-backed positions read correctly and iterate in member order', async () => {
    const input = smallInput();
    const table = buildIndexTable(input.cut.members);
    const { input: workerInput } = decodeRequest(encodeRequest(1, 'grid', input, table));
    const result = await gridProvider.compute(workerInput);
    const res = encodeResponse(1, result, workerInput);
    const lazy = decodeResponseLazy(res, table, input.edges);

    expect(lazy.positions.size).toBe(4);
    expect([...lazy.positions.keys()].map(String)).toEqual(['a', 'b', 'c', 'd']);
    expect(lazy.edgeRoutes).toBeUndefined(); // grid emits no routes
    // get(id) slices the four lanes on demand and equals the eager decode
    const eager = decodeResponse(res, table, input.edges);
    for (const id of input.cut.members) {
      expect(rectEq(rectOf(lazy.positions, String(id)), rectOf(eager.positions, String(id)))).toBe(true);
    }
    expect(lazy.positions.has(n('a'))).toBe(true);
    expect(lazy.positions.get(n('zzz'))).toBeUndefined();
  });
});
