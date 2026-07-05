/**
 * Fluent query API (ROADMAP Phase 1 §5): index-backed, AND-composed,
 * deterministic ordering, live against the store head.
 */
import { asEdgeId, asGraphId, asNodeId } from '@meridian/graph-core';
import { describe, expect, it } from 'vitest';
import { createStore } from '../src/index.js';
import { demoSpace, gLeaf, gMid, gRoot, nA, nB, nC, nD, ORIGIN, SRC } from './helpers.js';

describe('query', () => {
  it('byKind returns sorted ids across graphs', () => {
    const store = createStore(demoSpace());
    expect(store.query().byKind('demo:module').ids()).toEqual([nA, nB]);
    expect(store.query().byKind('demo:step').ids()).toEqual([nC, nD]);
    expect(store.query().byKind('demo:ghost').ids()).toEqual([]);
  });

  it('within restricts to one graph; constraints AND-compose', () => {
    const store = createStore(demoSpace());
    expect(store.query().within(gMid).ids()).toEqual([nC]);
    expect(store.query().byKind('demo:step').within(gLeaf).ids()).toEqual([nD]);
    expect(store.query().byKind('demo:module').within(gLeaf).ids()).toEqual([]);
  });

  it('text matches all query tokens against label tokens, unicode-aware', () => {
    const store = createStore(demoSpace());
    store.apply({
      origin: ORIGIN,
      ops: [
        {
          t: 'node:add',
          graph: gRoot,
          node: { id: asNodeId('n-t'), kind: 'demo:step', label: 'Parse the Args — vite-style', attrs: {}, provenance: SRC },
        },
      ],
    });
    expect(store.query().text('parse').ids()).toEqual(['n-t']);
    expect(store.query().text('ARGS parse').ids()).toEqual(['n-t']);
    expect(store.query().text('vite style').ids()).toEqual(['n-t']);
    expect(store.query().text('parsing').ids()).toEqual([]); // exact tokens, no stemming
  });

  it('neighborsOf follows adjacency with direction and edge-kind filters', () => {
    const store = createStore(demoSpace());
    expect(store.query().neighborsOf(nA).ids()).toEqual([nB]);
    expect(store.query().neighborsOf(nA, { direction: 'in' }).ids()).toEqual([]);
    expect(store.query().neighborsOf(nB, { direction: 'in' }).ids()).toEqual([nA]);
    expect(store.query().neighborsOf(nA, { edgeKind: 'core:references' }).ids()).toEqual([nB]);
    expect(store.query().neighborsOf(nA, { edgeKind: 'demo:none' }).ids()).toEqual([]);
  });

  it('reflects committed mutations immediately (head-only indices)', () => {
    const store = createStore(demoSpace());
    store.apply({
      origin: ORIGIN,
      ops: [
        { t: 'node:add', graph: gLeaf, node: { id: asNodeId('n-q'), kind: 'demo:module', label: 'query me', attrs: {}, provenance: SRC } },
        { t: 'edge:add', graph: gLeaf, edge: { id: asEdgeId('e-q'), src: asNodeId('n-q'), dst: nD, kind: 'demo:points', attrs: {}, provenance: SRC } },
      ],
    });
    expect(store.query().byKind('demo:module').ids()).toEqual([nA, nB, 'n-q']);
    expect(store.query().text('query').ids()).toEqual(['n-q']);
    expect(store.query().neighborsOf(nD, { direction: 'in' }).ids()).toEqual(['n-q']);
    store.apply({
      origin: ORIGIN,
      ops: [
        { t: 'edge:remove', graph: gLeaf, id: asEdgeId('e-q') },
        { t: 'node:remove', graph: gLeaf, id: asNodeId('n-q') },
      ],
    });
    expect(store.query().byKind('demo:module').ids()).toEqual([nA, nB]);
    expect(store.query().text('query').ids()).toEqual([]);
    expect(store.query().neighborsOf(nD, { direction: 'in' }).ids()).toEqual([]);
  });

  it('nodes() materializes full nodes in id order', () => {
    const store = createStore(demoSpace());
    const nodes = store.query().byKind('demo:module').nodes();
    expect(nodes.map((n) => n.id)).toEqual([nA, nB]);
    expect(nodes[0]!.label).toBe('a');
  });

  it('an unconstrained query enumerates every node', () => {
    const store = createStore(demoSpace());
    expect(store.query().ids()).toEqual([nA, nB, nC, nD]);
    expect(store.query().within(asGraphId('g-ghost')).ids()).toEqual([]);
  });
});
