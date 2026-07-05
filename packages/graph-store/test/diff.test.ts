/**
 * diffSpaces hand cases: the corners the property suite reaches only by
 * luck — claim swaps, core-changed nodes with surviving edges, meta-only
 * changes, fully disjoint spaces.
 */
import { addEdge, addGraph, addNode, asEdgeId, asGraphId, asNodeId, type GraphSpace } from '@meridian/graph-core';
import { describe, expect, it } from 'vitest';
import { applyDelta, diffSpaces } from '../src/index.js';
import { canonical, demoSpace, gLeaf, gMid, gRoot, nA, nB, SRC } from './helpers.js';

function replayCheck(a: GraphSpace, b: GraphSpace): void {
  const delta = diffSpaces(a, b);
  const result = applyDelta(a, delta);
  expect(result.ok, !result.ok ? JSON.stringify(result.errors, null, 2) : '').toBe(true);
  if (result.ok) expect(canonical(result.space)).toBe(canonical(b));
}

const empty: GraphSpace = { graphs: new Map(), roots: [] };

describe('diffSpaces hand cases', () => {
  it('identical spaces produce an empty delta', () => {
    expect(diffSpaces(demoSpace(), demoSpace()).ops).toEqual([]);
  });

  it('builds a space from nothing and tears it down to nothing', () => {
    replayCheck(empty, demoSpace());
    replayCheck(demoSpace(), empty);
  });

  it('meta-only change is one graph:meta op', () => {
    const a = demoSpace();
    const b = { ...a, graphs: new Map(a.graphs) };
    const g = b.graphs.get(gRoot)!;
    b.graphs.set(gRoot, { ...g, meta: { ...g.meta, label: 'Renamed' } });
    const delta = diffSpaces(a, b);
    expect(delta.ops).toHaveLength(1);
    expect(delta.ops[0]).toMatchObject({ t: 'graph:meta', graph: gRoot, next: { label: 'Renamed' } });
    replayCheck(a, b);
  });

  it('core-changed node is re-added and its surviving edges are preserved', () => {
    const a = demoSpace();
    const b = { ...a, graphs: new Map(a.graphs) };
    const g = b.graphs.get(gRoot)!;
    const nodes = new Map(g.nodes);
    nodes.set(nB, { ...nodes.get(nB)!, label: 'b renamed' }); // core change
    b.graphs.set(gRoot, { ...g, nodes });
    const delta = diffSpaces(a, b);
    // e-ab is incident to n-b: must be removed and re-added around the swap.
    expect(delta.ops.map((op) => op.t)).toEqual([
      'edge:remove',
      'node:remove',
      'node:add',
      'edge:add',
    ]);
    replayCheck(a, b);
  });

  it('claim swap: detail moves between nodes without transient double-claims', () => {
    // a: n-a holds g-mid; b: n-a clear, n-b holds g-mid.
    const a = demoSpace();
    const b = { ...a, graphs: new Map(a.graphs) };
    const g = b.graphs.get(gRoot)!;
    const nodes = new Map(g.nodes);
    const na = nodes.get(nA)!;
    const nb = nodes.get(nB)!;
    nodes.set(nA, { id: na.id, kind: na.kind, label: na.label, attrs: na.attrs, provenance: na.provenance });
    nodes.set(nB, { ...nb, detail: { graph: gMid } });
    b.graphs.set(gRoot, { ...g, nodes });
    const delta = diffSpaces(a, b);
    const clearIdx = delta.ops.findIndex((op) => op.t === 'node:detail' && op.id === nA);
    const setIdx = delta.ops.findIndex((op) => op.t === 'node:detail' && op.id === nB);
    expect(clearIdx).toBeGreaterThanOrEqual(0);
    expect(setIdx).toBeGreaterThan(clearIdx); // clear strictly before set
    replayCheck(a, b);
  });

  it('reparenting across graphs: released child claimed by a brand-new node in a new graph', () => {
    const a = demoSpace();
    // b: g-mid's claim moves from n-a (g-root) to a node in a new root graph.
    let b = demoSpace();
    const g = b.graphs.get(gRoot)!;
    const nodes = new Map(g.nodes);
    const na = nodes.get(nA)!;
    nodes.set(nA, { id: na.id, kind: na.kind, label: na.label, attrs: na.attrs, provenance: na.provenance });
    const graphs = new Map(b.graphs);
    graphs.set(gRoot, { ...g, nodes });
    b = { graphs, roots: [...b.roots, gMid] }; // clearing n-a's detail makes g-mid a root
    b = addGraph(b, { id: asGraphId('g-side'), label: 'Side', domain: 'demo', provenance: SRC });
    b = addNode(b, asGraphId('g-side'), {
      id: asNodeId('n-side'),
      kind: 'demo:module',
      label: 'side',
      detail: { graph: gMid },
      provenance: SRC,
    });
    replayCheck(a, b);
  });

  it('attr-level diffs: added, removed, and changed keys', () => {
    let a: GraphSpace = { graphs: new Map(), roots: [] };
    a = addGraph(a, { id: asGraphId('g'), label: 'G', domain: 'demo', provenance: SRC });
    a = addNode(a, asGraphId('g'), {
      id: asNodeId('n'),
      kind: 'demo:step',
      label: 'n',
      attrs: { 'demo:keep': 1, 'demo:change': 'old', 'demo:drop': true },
      provenance: SRC,
    });
    let b: GraphSpace = { graphs: new Map(), roots: [] };
    b = addGraph(b, { id: asGraphId('g'), label: 'G', domain: 'demo', provenance: SRC });
    b = addNode(b, asGraphId('g'), {
      id: asNodeId('n'),
      kind: 'demo:step',
      label: 'n',
      attrs: { 'demo:keep': 1, 'demo:change': 'new', 'demo:added': [1, 2] },
      provenance: SRC,
    });
    const delta = diffSpaces(a, b);
    expect(delta.ops).toEqual([
      { t: 'node:attr', graph: 'g', id: 'n', key: 'demo:added', next: [1, 2] },
      { t: 'node:attr', graph: 'g', id: 'n', key: 'demo:change', prev: 'old', next: 'new' },
      { t: 'node:attr', graph: 'g', id: 'n', key: 'demo:drop', prev: true },
    ]);
    replayCheck(a, b);
  });

  it('edge rewires (endpoint change) are remove + add', () => {
    const a = demoSpace();
    let b = demoSpace();
    const g = b.graphs.get(gRoot)!;
    const edges = new Map(g.edges);
    const e = edges.get(asEdgeId('e-ab'))!;
    edges.set(asEdgeId('e-ab'), { ...e, src: nB, dst: nA }); // reversed
    const graphs = new Map(b.graphs);
    graphs.set(gRoot, { ...g, edges });
    b = { graphs, roots: b.roots };
    const delta = diffSpaces(a, b);
    expect(delta.ops.map((op) => op.t)).toEqual(['edge:remove', 'edge:add']);
    replayCheck(a, b);
  });

  it('deep teardown: removing a whole subtree releases and deletes cleanly', () => {
    const a = demoSpace();
    // b: only g-root remains, n-a loses its detail, g-mid/g-leaf gone.
    let b: GraphSpace = { graphs: new Map(), roots: [] };
    b = addGraph(b, { id: gRoot, label: 'Root', domain: 'demo', provenance: SRC });
    b = addNode(b, gRoot, { id: nA, kind: 'demo:module', label: 'a', provenance: SRC });
    b = addNode(b, gRoot, { id: nB, kind: 'demo:module', label: 'b', provenance: SRC });
    b = addEdge(b, gRoot, {
      id: asEdgeId('e-ab'), src: nA, dst: nB, kind: 'core:references', weight: 0.5, provenance: SRC,
    });
    const delta = diffSpaces(a, b);
    replayCheck(a, b);
    // g-leaf's claim is held by n-c which is removed with g-mid — no explicit
    // clear needed, but the graph removals must come after the node removals.
    const kinds = delta.ops.map((op) => op.t);
    expect(kinds.lastIndexOf('node:remove')).toBeLessThan(kinds.indexOf('graph:remove'));
    expect([gLeaf, gMid].every((id) => delta.ops.some((op) => op.t === 'graph:remove' && op.graph === id))).toBe(true);
  });
});
