/**
 * GraphStore behavior (ROADMAP Phase 1 §5–6): creation, apply/completion,
 * versioning, snapshot sharing (ADR-0006), transactions with cascade and
 * rollback, undo via invertDelta against the live store.
 */
import { asEdgeId, asGraphId, asNodeId, validate, type GraphSpace } from '@meridian/graph-core';
import { describe, expect, it } from 'vitest';
import { applyDelta, createStore, invertDelta, type GraphDeltaInput } from '../src/index.js';
import { canonical, demoSpace, eAB, gLeaf, gMid, gRoot, nA, nB, nC, nD, ORIGIN, SRC } from './helpers.js';

const gNew = asGraphId('g-new');
const nNew = asNodeId('n-new');

describe('createStore', () => {
  it('starts at v0 with an O(1) snapshot identical to the (normalized) input', () => {
    const space = demoSpace();
    const store = createStore(space);
    expect(store.version()).toEqual({ counter: 0, site: 'local' });
    expect(store.snapshot().graphs).toBe(space.graphs); // shared, not copied
    expect(canonical(store.snapshot())).toBe(canonical(space));
  });

  it('normalizes root order to the canonical sorted form', () => {
    const space = demoSpace();
    const shuffled: GraphSpace = { graphs: space.graphs, roots: [...space.roots].reverse() };
    const store = createStore(shuffled);
    expect(store.snapshot().roots).toEqual([...shuffled.roots].sort());
  });

  it('rejects invalid spaces loudly — feeding the store garbage is a bug', () => {
    const space = demoSpace();
    const broken: GraphSpace = { graphs: space.graphs, roots: [] }; // root-mismatch
    expect(() => createStore(broken)).toThrow(/invalid-space|root/);
  });
});

describe('apply', () => {
  it('applies a delta atomically, completes ops, and advances the version', () => {
    const store = createStore(demoSpace());
    const result = store.apply({
      origin: ORIGIN,
      ops: [
        { t: 'node:attr', graph: gRoot, id: nB, key: 'demo:count', next: 2 },
        { t: 'edge:remove', graph: gRoot, id: eAB },
      ],
    });
    expect(result.ok, !result.ok ? JSON.stringify(result.errors) : '').toBe(true);
    if (!result.ok) return;
    expect(store.version()).toEqual({ counter: 1, site: 'local' });
    expect(result.delta.baseVersion).toEqual({ counter: 0, site: 'local' });
    // Completion: the edge:remove op now carries the removed edge.
    expect(result.delta.ops[1]).toMatchObject({
      t: 'edge:remove',
      prev: { id: eAB, src: nA, dst: nB, kind: 'core:references' },
    });
    const node = store.snapshot().graphs.get(gRoot)!.nodes.get(nB)!;
    expect(node.attrs['demo:count']).toBe(2);
  });

  it('shares untouched graphs and elements across versions (ADR-0006)', () => {
    const store = createStore(demoSpace());
    const before = store.snapshot();
    store.apply({
      origin: ORIGIN,
      ops: [{ t: 'node:attr', graph: gRoot, id: nB, key: 'demo:count', next: 1 }],
    });
    const after = store.snapshot();
    expect(after).not.toBe(before);
    expect(after.graphs.get(gMid)).toBe(before.graphs.get(gMid)); // untouched graph shared
    expect(after.graphs.get(gLeaf)).toBe(before.graphs.get(gLeaf));
    expect(after.graphs.get(gRoot)).not.toBe(before.graphs.get(gRoot));
    // Untouched node objects shared even inside the touched graph.
    expect(after.graphs.get(gRoot)!.nodes.get(nA)).toBe(before.graphs.get(gRoot)!.nodes.get(nA));
    expect(after.graphs.get(gRoot)!.nodes.get(nB)).not.toBe(before.graphs.get(gRoot)!.nodes.get(nB));
    // The old snapshot is untouched (immutability).
    expect(before.graphs.get(gRoot)!.nodes.get(nB)!.attrs['demo:count']).toBeUndefined();
    expect(validate(after).ok).toBe(true);
  });

  it('honors a matching baseVersion and canonicalizes payload strings', () => {
    const store = createStore(demoSpace());
    const decomposed = 'é'; // é as base + combining accent
    const result = store.apply({
      baseVersion: { counter: 0, site: 'local' },
      origin: ORIGIN,
      ops: [{ t: 'node:add', graph: gRoot, node: { id: nNew, kind: 'demo:step', label: decomposed, attrs: {}, provenance: SRC } }],
    });
    expect(result.ok).toBe(true);
    const label = store.snapshot().graphs.get(gRoot)!.nodes.get(nNew)!.label;
    expect(label).toBe(decomposed.normalize('NFC'));
    expect(label).not.toBe(decomposed);
  });

  it('releases and claims detail graphs through node:detail, maintaining sorted roots', () => {
    const store = createStore(demoSpace());
    const r1 = store.apply({
      origin: ORIGIN,
      ops: [{ t: 'node:detail', graph: gRoot, id: nA }], // clear: g-mid becomes a root
    });
    expect(r1.ok).toBe(true);
    expect(store.snapshot().roots).toEqual([gMid, gRoot]);
    const r2 = store.apply({
      origin: ORIGIN,
      ops: [{ t: 'node:detail', graph: gRoot, id: nB, next: { graph: gMid } }],
    });
    expect(r2.ok).toBe(true);
    expect(store.snapshot().roots).toEqual([gRoot]);
    expect(validate(store.snapshot()).ok).toBe(true);
    if (r2.ok) expect(r2.delta.ops[0]).toEqual({ t: 'node:detail', graph: gRoot, id: nB, next: { graph: gMid } });
  });

  it('prev assertions catch state drift (op-conflict)', () => {
    const store = createStore(demoSpace());
    const result = store.apply({
      origin: ORIGIN,
      ops: [{ t: 'node:attr', graph: gLeaf, id: nD, key: 'demo:x', prev: 'wrong', next: 'y' }],
    });
    expect(result).toMatchObject({ ok: false, errors: [{ code: 'op-conflict', opIndex: 0 }] });
  });
});

describe('undo via invertDelta (I4 against the live store)', () => {
  it('apply → invert → apply restores the original space, canonically', () => {
    const store = createStore(demoSpace());
    const before = canonical(store.snapshot());
    const result = store.apply({
      origin: ORIGIN,
      ops: [
        { t: 'graph:add', graph: gNew, meta: { label: 'New', domain: 'demo', provenance: SRC } },
        { t: 'node:add', graph: gNew, node: { id: nNew, kind: 'demo:step', label: 'n', attrs: {}, provenance: SRC } },
        { t: 'node:detail', graph: gRoot, id: nB, next: { graph: gNew } },
        { t: 'node:attr', graph: gLeaf, id: nD, key: 'demo:x', next: [1, 2, 3] },
        { t: 'edge:remove', graph: gRoot, id: eAB },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(canonical(store.snapshot())).not.toBe(before);
    const undo = store.apply(invertDelta(result.delta, { actor: 'undo' }));
    expect(undo.ok, !undo.ok ? JSON.stringify(undo.errors) : '').toBe(true);
    expect(canonical(store.snapshot())).toBe(before);
    expect(store.version()).toEqual({ counter: 2, site: 'local' }); // history is append-only
  });
});

describe('transact', () => {
  it('records ops eagerly, commits once, and cascades removeNode edges', () => {
    const store = createStore(demoSpace());
    const result = store.transact((tx) => {
      tx.setAttr(gRoot, nB, 'demo:count', 7);
      tx.removeNode(gRoot, nA); // has edge e-ab and detail g-mid
    }, ORIGIN);
    expect(result.ok, !result.ok ? JSON.stringify(result.errors) : '').toBe(true);
    if (!result.ok) return;
    expect(result.delta.ops.map((op) => op.t)).toEqual(['node:attr', 'edge:remove', 'node:remove']);
    expect(store.snapshot().roots).toEqual([gMid, gRoot]); // g-mid released to root
    expect(store.version().counter).toBe(1); // one commit for the whole callback
    expect(validate(store.snapshot()).ok).toBe(true);
  });

  it('rolls back completely when the callback throws', () => {
    const store = createStore(demoSpace());
    const before = store.snapshot();
    const result = store.transact((tx) => {
      tx.setAttr(gRoot, nB, 'demo:count', 7);
      throw new Error('changed my mind');
    }, ORIGIN);
    expect(result).toMatchObject({ ok: false, errors: [{ code: 'transaction-aborted' }] });
    expect(store.snapshot()).toBe(before); // same object — nothing committed
    expect(store.version().counter).toBe(0);
  });

  it('reports the failing op with its index and leaves state untouched', () => {
    const store = createStore(demoSpace());
    const before = store.snapshot();
    const result = store.transact((tx) => {
      tx.setAttr(gRoot, nB, 'demo:count', 7); // valid
      tx.removeEdge(gMid, asEdgeId('e-missing')); // invalid
    }, ORIGIN);
    expect(result).toMatchObject({ ok: false, errors: [{ code: 'unknown-edge', opIndex: 1 }] });
    expect(store.snapshot()).toBe(before);
  });

  it('rejects an empty transaction like an empty delta', () => {
    const store = createStore(demoSpace());
    expect(store.transact(() => {}, ORIGIN)).toMatchObject({
      ok: false,
      errors: [{ code: 'empty-delta' }],
    });
  });

  it('exercises the full vocabulary through tx methods and stays valid', () => {
    const store = createStore(demoSpace());
    const result = store.transact((tx) => {
      tx.addGraph({ id: gNew, label: 'New', domain: 'demo', provenance: SRC });
      tx.addNode(gNew, { id: nNew, kind: 'demo:step', label: 'fresh', provenance: SRC });
      tx.addEdge(gNew, { id: asEdgeId('e-new'), src: nNew, dst: nNew, kind: 'demo:recurses', provenance: SRC });
      tx.setGraphMeta(gNew, { label: 'Newer', domain: 'demo', provenance: SRC });
      tx.setDetail(gRoot, nB, { graph: gNew });
      tx.setAttr(gNew, nNew, 'demo:flag', true);
      tx.setAttr(gNew, nNew, 'demo:flag', undefined); // remove the key again
      tx.setDetail(gRoot, nB, undefined);
      tx.removeEdge(gNew, asEdgeId('e-new'));
      tx.removeNode(gNew, nNew);
      tx.removeGraph(gNew);
    }, ORIGIN);
    expect(result.ok, !result.ok ? JSON.stringify(result.errors) : '').toBe(true);
    expect(canonical(store.snapshot())).toBe(canonical(demoSpace()));
    expect(validate(store.snapshot()).ok).toBe(true);
  });

  it('a transaction object cannot escape its callback', () => {
    const store = createStore(demoSpace());
    let escaped: Parameters<Parameters<typeof store.transact>[0]>[0] | undefined;
    store.transact((tx) => {
      tx.setAttr(gRoot, nB, 'demo:count', 1);
      escaped = tx;
    }, ORIGIN);
    expect(() => escaped!.setAttr(gRoot, nB, 'demo:count', 2)).toThrow(/transaction/i);
  });
});

describe('pure applyDelta', () => {
  it('transforms a space without a store and completes ops', () => {
    const space = demoSpace();
    const delta: GraphDeltaInput = {
      origin: ORIGIN,
      ops: [{ t: 'node:remove', graph: gMid, id: nC }],
    };
    const result = applyDelta(space, delta);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ops[0]).toMatchObject({ t: 'node:remove', prev: { id: nC, kind: 'demo:step' } });
    expect(result.space.graphs.get(gMid)!.nodes.has(nC)).toBe(false);
    expect(result.space.roots).toEqual([gLeaf, gRoot].sort()); // g-leaf released
    expect(space.graphs.get(gMid)!.nodes.has(nC)).toBe(true); // input untouched
    expect(validate(result.space).ok).toBe(true);
  });
});
