/**
 * Incremental induced-edge cache (ADR-0013; ROADMAP Phase 3 §12): a committed
 * ChangeSet recomputes *exactly* the affected visible ancestors, never the
 * whole cut — asserted by recompute-count, not vibes — and the cache's
 * `resolve()` always equals a from-scratch `aggregateEdges`. Structure-changing
 * ops raise `CutStaleError` (rebuild the cut). Includes a churn property:
 * across random edge add/removes the cache stays equal to full re-aggregation
 * while only ever touching endpoint covers.
 */
import {
  addEdge,
  addGraph,
  addNode,
  asEdgeId,
  asGraphId,
  asNodeId,
  type GraphSpace,
  type NodeId,
  type SourceRef,
} from '@meridian/graph-core';
import { createStore } from '@meridian/graph-store';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildCut } from '../src/cut.js';
import { buildLevelChain } from '../src/level-chain.js';
import { aggregateEdges, buildNodeCover } from '../src/induced.js';
import { CutStaleError, InducedEdgeCache } from '../src/induced-cache.js';

const SRC: SourceRef = { origin: 'source', uri: 'test://cache' };
const ORIGIN = { actor: 'test' };
const nid = (s: string): NodeId => asNodeId(s);

/**
 * Root g with 5 siblings A,B,C,D,E; B and D carry two-leaf detail graphs. At
 * level 0 every sibling is a member (5 members); intra-detail edges are
 * internal to their parent.
 */
function wideSpace(): GraphSpace {
  let s: GraphSpace = { graphs: new Map(), roots: [] };
  for (const id of ['g', 'gB', 'gD']) {
    s = addGraph(s, { id: asGraphId(id), label: id, domain: 'test', provenance: SRC });
  }
  s = addNode(s, asGraphId('gB'), { id: nid('b1'), kind: 'test:leaf', label: 'b1', provenance: SRC });
  s = addNode(s, asGraphId('gB'), { id: nid('b2'), kind: 'test:leaf', label: 'b2', provenance: SRC });
  s = addNode(s, asGraphId('gD'), { id: nid('d1'), kind: 'test:leaf', label: 'd1', provenance: SRC });
  s = addNode(s, asGraphId('gD'), { id: nid('d2'), kind: 'test:leaf', label: 'd2', provenance: SRC });
  s = addNode(s, asGraphId('g'), { id: nid('A'), kind: 'test:leaf', label: 'A', provenance: SRC });
  s = addNode(s, asGraphId('g'), { id: nid('B'), kind: 'test:group', label: 'B', detail: { graph: asGraphId('gB') }, provenance: SRC });
  s = addNode(s, asGraphId('g'), { id: nid('C'), kind: 'test:leaf', label: 'C', provenance: SRC });
  s = addNode(s, asGraphId('g'), { id: nid('D'), kind: 'test:group', label: 'D', detail: { graph: asGraphId('gD') }, provenance: SRC });
  s = addNode(s, asGraphId('g'), { id: nid('E'), kind: 'test:leaf', label: 'E', provenance: SRC });
  s = addEdge(s, asGraphId('g'), { id: asEdgeId('e0'), src: nid('A'), dst: nid('C'), kind: 'rel:a', provenance: SRC });
  s = addEdge(s, asGraphId('gB'), { id: asEdgeId('eb'), src: nid('b1'), dst: nid('b2'), kind: 'rel:y', provenance: SRC });
  return s;
}

describe('InducedEdgeCache — resolve equals aggregateEdges', () => {
  it('reproduces the from-scratch induced set for a fresh cut', () => {
    const space = wideSpace();
    const cut = buildCut(space, buildLevelChain(space), 0);
    const cache = new InducedEdgeCache(space, cut);
    expect(cache.resolve()).toEqual(aggregateEdges(space, cut));
  });
});

describe('InducedEdgeCache — exact invalidation (recompute-count)', () => {
  it('recomputes only the two endpoint members on a cross-edge add', () => {
    const space = wideSpace();
    const cut = buildCut(space, buildLevelChain(space), 0);
    expect(cut.members).toHaveLength(5);
    const cache = new InducedEdgeCache(space, cut);

    const store = createStore(space);
    const res = store.apply({
      origin: ORIGIN,
      ops: [{ t: 'edge:add', graph: asGraphId('g'), edge: { id: asEdgeId('e1'), src: nid('C'), dst: nid('E'), kind: 'rel:a', attrs: {}, provenance: SRC } }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const recomputed = cache.applyChange(res.changes, store.snapshot());
    // Exactly {A(C), A(E)} = {C, E}, not the whole 5-member cut.
    expect(recomputed).toEqual([nid('C'), nid('E')]);
    expect(recomputed.length).toBeLessThan(cut.members.length);
    expect(cache.resolve()).toEqual(aggregateEdges(store.snapshot(), cut));
  });

  it('recomputes only the covering member for an edge under a collapsed node', () => {
    const space = wideSpace();
    const cut = buildCut(space, buildLevelChain(space), 0);
    const cache = new InducedEdgeCache(space, cut);
    const before = cache.resolve();

    const store = createStore(space);
    // b2→b1 is internal to collapsed member B; both endpoints cover to B.
    const res = store.apply({
      origin: ORIGIN,
      ops: [{ t: 'edge:add', graph: asGraphId('gB'), edge: { id: asEdgeId('eb2'), src: nid('b2'), dst: nid('b1'), kind: 'rel:y', attrs: {}, provenance: SRC } }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const recomputed = cache.applyChange(res.changes, store.snapshot());
    expect(recomputed).toEqual([nid('B')]); // only B, and it is a no-op
    expect(cache.resolve()).toEqual(before); // internal edge changes nothing
    expect(cache.resolve()).toEqual(aggregateEdges(store.snapshot(), cut));
  });

  it('recomputes only the touched node’s cover on a node:attr change', () => {
    const space = wideSpace();
    const cut = buildCut(space, buildLevelChain(space), 0);
    const cache = new InducedEdgeCache(space, cut);

    const store = createStore(space);
    const res = store.apply({
      origin: ORIGIN,
      ops: [{ t: 'node:attr', graph: asGraphId('g'), id: nid('A'), key: 'test:touch', next: 1 }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const recomputed = cache.applyChange(res.changes, store.snapshot());
    expect(recomputed).toEqual([nid('A')]);
    expect(cache.resolve()).toEqual(aggregateEdges(store.snapshot(), cut));
  });

  it('removing a cross edge recomputes only its endpoint covers', () => {
    const space = wideSpace();
    const cut = buildCut(space, buildLevelChain(space), 0);
    const cache = new InducedEdgeCache(space, cut);

    const store = createStore(space);
    const res = store.apply({
      origin: ORIGIN,
      ops: [{ t: 'edge:remove', graph: asGraphId('g'), id: asEdgeId('e0') }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const recomputed = cache.applyChange(res.changes, store.snapshot());
    expect(recomputed).toEqual([nid('A'), nid('C')]);
    expect(cache.resolve()).toEqual(aggregateEdges(store.snapshot(), cut));
    expect(cache.resolve()).toEqual([]); // the only cross edge is gone
  });
});

describe('InducedEdgeCache — forest-changing ops are refused', () => {
  it('raises CutStaleError on a node:add (the cut may move)', () => {
    const space = wideSpace();
    const cut = buildCut(space, buildLevelChain(space), 0);
    const cache = new InducedEdgeCache(space, cut);

    const store = createStore(space);
    const res = store.apply({
      origin: ORIGIN,
      ops: [{ t: 'node:add', graph: asGraphId('g'), node: { id: nid('F'), kind: 'test:leaf', label: 'F', attrs: {}, provenance: SRC } }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(() => cache.applyChange(res.changes, store.snapshot())).toThrow(CutStaleError);
  });
});

describe('InducedEdgeCache — churn property', () => {
  it('stays equal to full re-aggregation while touching only endpoint covers', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ src: fc.constantFrom('A', 'C', 'E'), dst: fc.constantFrom('A', 'C', 'E'), kind: fc.constantFrom('rel:a', 'rel:b') }),
          { minLength: 1, maxLength: 12 },
        ),
        (edgeSpecs) => {
          const space = wideSpace();
          const cut = buildCut(space, buildLevelChain(space), 0);
          const cache = new InducedEdgeCache(space, cut);
          const cover = buildNodeCover(space, cut);
          const store = createStore(space);

          edgeSpecs.forEach((spec, i) => {
            const res = store.apply({
              origin: ORIGIN,
              ops: [{ t: 'edge:add', graph: asGraphId('g'), edge: { id: asEdgeId(`c${i}`), src: nid(spec.src), dst: nid(spec.dst), kind: spec.kind, attrs: {}, provenance: SRC } }],
            });
            expect(res.ok).toBe(true);
            if (!res.ok) return;
            const recomputed = cache.applyChange(res.changes, store.snapshot());
            // Every recomputed member is one of the edit's endpoint covers.
            const allowed = new Set([cover.get(nid(spec.src)), cover.get(nid(spec.dst))]);
            for (const m of recomputed) expect(allowed.has(m)).toBe(true);
            expect(cache.resolve()).toEqual(aggregateEdges(store.snapshot(), cut));
          });
        },
      ),
      { numRuns: 150 },
    );
  });
});
