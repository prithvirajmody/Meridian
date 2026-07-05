/**
 * Failure cases (ROADMAP Phase 1 §12): stale baseVersion, atomic rollback on
 * mid-delta violations (state, indices, version all untouched), invariant
 * attacks (U1/U2/U3), invalid payloads, and script-gate aggregation.
 */
import { asGraphId, asNodeId, validate } from '@meridian/graph-core';
import { describe, expect, it } from 'vitest';
import { createStore, decodeDelta, decodeDeltaInput } from '../src/index.js';
import { canonical, demoSpace, eAB, gLeaf, gMid, gRoot, nA, nB, nC, nD, ORIGIN, SRC } from './helpers.js';

describe('delta envelope failures', () => {
  it('rejects a stale baseVersion without touching anything', () => {
    const store = createStore(demoSpace());
    store.apply({ origin: ORIGIN, ops: [{ t: 'node:attr', graph: gRoot, id: nB, key: 'demo:count', next: 1 }] });
    const before = store.snapshot();
    const result = store.apply({
      baseVersion: { counter: 0, site: 'local' }, // store is at 1
      origin: ORIGIN,
      ops: [{ t: 'node:attr', graph: gRoot, id: nB, key: 'demo:count', next: 2 }],
    });
    expect(result).toMatchObject({ ok: false, errors: [{ code: 'stale-delta' }] });
    expect(store.snapshot()).toBe(before);
    expect(store.version().counter).toBe(1);
  });

  it('rejects empty deltas and empty/missing origins', () => {
    const store = createStore(demoSpace());
    expect(store.apply({ origin: ORIGIN, ops: [] })).toMatchObject({
      ok: false,
      errors: [{ code: 'empty-delta' }],
    });
    expect(store.apply({ origin: { actor: '' }, ops: [{ t: 'graph:remove', graph: gLeaf }] })).toMatchObject({
      ok: false,
      errors: [{ code: 'invalid-delta' }],
    });
  });
});

describe('atomic rollback', () => {
  it('an op referencing a missing node aborts the whole delta — state, version, and indices untouched', () => {
    const store = createStore(demoSpace());
    const before = store.snapshot();
    const result = store.apply({
      origin: ORIGIN,
      ops: [
        { t: 'node:attr', graph: gRoot, id: nB, key: 'demo:count', next: 1 }, // valid
        { t: 'node:attr', graph: gRoot, id: asNodeId('n-ghost'), key: 'demo:count', next: 2 }, // invalid
      ],
    });
    expect(result).toMatchObject({ ok: false, errors: [{ code: 'unknown-node', opIndex: 1 }] });
    expect(store.snapshot()).toBe(before); // very same object
    expect(store.version().counter).toBe(0);
    // Indices unpoisoned: the valid first op did not leak into the query index.
    expect(store.query().byKind('demo:module').ids()).toEqual([nA, nB]);
    // And a follow-up valid delta still works against clean state.
    const retry = store.apply({
      origin: ORIGIN,
      ops: [{ t: 'node:attr', graph: gRoot, id: nB, key: 'demo:count', next: 1 }],
    });
    expect(retry.ok).toBe(true);
  });
});

describe('invariant attacks', () => {
  it('U1: cross-graph edges are refused with the portal-rule pointer', () => {
    const store = createStore(demoSpace());
    const result = store.apply({
      origin: ORIGIN,
      ops: [
        {
          t: 'edge:add',
          graph: gRoot,
          edge: { id: 'e-x' as never, src: nA, dst: nD, kind: 'core:references', attrs: {}, provenance: SRC },
        },
      ],
    });
    expect(result).toMatchObject({ ok: false, errors: [{ code: 'cross-graph-edge' }] });
    if (!result.ok) expect(result.errors[0]!.message).toMatch(/portal rule/);
  });

  it('U2: claiming an ancestor (or self) as detail is a containment cycle', () => {
    const store = createStore(demoSpace());
    // g-root is a root but an ancestor of g-mid → cycle refused.
    const ancestor = store.apply({
      origin: ORIGIN,
      ops: [{ t: 'node:detail', graph: gMid, id: nC, next: { graph: gRoot } }],
    });
    expect(ancestor).toMatchObject({ ok: false, errors: [{ code: 'containment-cycle' }] });
    // Self-claim: a node in g-root claiming g-root itself.
    const self = store.apply({
      origin: ORIGIN,
      ops: [{ t: 'node:detail', graph: gRoot, id: nB, next: { graph: gRoot } }],
    });
    expect(self).toMatchObject({ ok: false, errors: [{ code: 'containment-cycle' }] });
    // g-mid is n-a's detail already: the U3 check fires first for non-roots.
    const claimed = store.apply({
      origin: ORIGIN,
      ops: [{ t: 'node:detail', graph: gMid, id: nC, next: { graph: gMid } }],
    });
    expect(claimed).toMatchObject({ ok: false, errors: [{ code: 'detail-not-root' }] });
    expect(validate(store.snapshot()).ok).toBe(true);
  });

  it('U3: a graph already claimed cannot be claimed again', () => {
    const store = createStore(demoSpace());
    const result = store.apply({
      origin: ORIGIN,
      ops: [{ t: 'node:detail', graph: gRoot, id: nB, next: { graph: gLeaf } }], // g-leaf is n-c's detail
    });
    expect(result).toMatchObject({ ok: false, errors: [{ code: 'detail-not-root' }] });
  });

  it('node:remove refuses while incident edges remain', () => {
    const store = createStore(demoSpace());
    const result = store.apply({ origin: ORIGIN, ops: [{ t: 'node:remove', graph: gRoot, id: nA }] });
    expect(result).toMatchObject({ ok: false, errors: [{ code: 'node-has-edges' }] });
  });

  it('graph:remove refuses non-empty or still-contained graphs', () => {
    const store = createStore(demoSpace());
    expect(store.apply({ origin: ORIGIN, ops: [{ t: 'graph:remove', graph: gLeaf }] })).toMatchObject({
      ok: false,
      errors: [{ code: 'graph-not-empty' }],
    });
    const emptied = store.apply({
      origin: ORIGIN,
      ops: [{ t: 'node:remove', graph: gLeaf, id: nD }, { t: 'graph:remove', graph: gLeaf }],
    });
    expect(emptied).toMatchObject({ ok: false, errors: [{ code: 'graph-contained', opIndex: 1 }] });
  });

  it('duplicate ids anywhere in the space are refused', () => {
    const store = createStore(demoSpace());
    const dupNode = store.apply({
      origin: ORIGIN,
      ops: [{ t: 'node:add', graph: gLeaf, node: { id: nB, kind: 'demo:step', label: '', attrs: {}, provenance: SRC } }],
    });
    expect(dupNode).toMatchObject({ ok: false, errors: [{ code: 'duplicate-id' }] });
    const dupGraph = store.apply({
      origin: ORIGIN,
      ops: [{ t: 'graph:add', graph: asGraphId('n-a'), meta: { label: '', domain: 'demo', provenance: SRC } }],
    });
    expect(dupGraph).toMatchObject({ ok: false, errors: [{ code: 'duplicate-id' }] });
  });

  it('invalid payloads: bad kind, reserved core attr, bad weight, bad provenance', () => {
    const store = createStore(demoSpace());
    const cases = [
      {
        op: { t: 'node:add' as const, graph: gRoot, node: { id: asNodeId('n-k'), kind: 'NotAKind', label: '', attrs: {}, provenance: SRC } },
        code: 'invalid-kind',
      },
      {
        op: { t: 'node:attr' as const, graph: gRoot, id: nB, key: 'core:salience', next: 1 },
        code: 'reserved-core-key',
      },
      {
        op: { t: 'node:attr' as const, graph: gRoot, id: nB, key: 'demo:bad', next: Number.NaN },
        code: 'invalid-attr-value',
      },
      {
        op: {
          t: 'edge:add' as const,
          graph: gRoot,
          edge: { id: 'e-w' as never, src: nA, dst: nB, kind: 'demo:x', weight: Number.POSITIVE_INFINITY, attrs: {}, provenance: SRC },
        },
        code: 'invalid-weight',
      },
      {
        op: {
          t: 'node:add' as const,
          graph: gRoot,
          node: { id: asNodeId('n-p'), kind: 'demo:step', label: '', attrs: {}, provenance: { origin: 'unknown' as never } },
        },
        code: 'invalid-provenance',
      },
    ];
    for (const { op, code } of cases) {
      expect(store.apply({ origin: ORIGIN, ops: [op] })).toMatchObject({ ok: false, errors: [{ code }] });
    }
    expect(canonical(store.snapshot())).toBe(canonical(demoSpace()));
  });
});

describe('script gate (decode)', () => {
  it('aggregates all structural errors with JSON paths', () => {
    const result = decodeDeltaInput({
      origin: { actor: '' },
      ops: [
        { t: 'node:zap', graph: 'g' },
        { t: 'node:add', graph: 'g', node: { id: 'x', kind: 'k:v', label: 1, provenance: { origin: 'nope' } } },
        { t: 'edge:remove', graph: '', id: 'e' },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.errors.map((e) => e.path);
    expect(paths).toContain('origin');
    expect(paths).toContain('ops[0].t');
    expect(paths).toContain('ops[1].node.label');
    expect(paths).toContain('ops[1].node.provenance.origin');
    expect(paths).toContain('ops[2].graph');
  });

  it('rejects malformed JSON text and non-object roots', () => {
    expect(decodeDeltaInput('{ nope')).toMatchObject({ ok: false });
    expect(decodeDeltaInput([1, 2])).toMatchObject({ ok: false });
  });

  it('decodeDelta additionally demands complete prev payloads (stamp stays optional — ADR-0007)', () => {
    const thin = {
      origin: { actor: 'x' },
      ops: [{ t: 'edge:remove', graph: 'g-root', id: 'e-ab' }],
    };
    expect(decodeDeltaInput(thin).ok).toBe(true);
    const result = decodeDelta(thin);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.path)).toEqual(['ops[0].prev']);
    }
  });

  it('round-trips a committed delta through the wire form', async () => {
    const { deltaToWire } = await import('../src/index.js');
    const store = createStore(demoSpace());
    const result = store.apply({
      origin: ORIGIN,
      ops: [
        { t: 'edge:remove', graph: gRoot, id: eAB },
        { t: 'node:remove', graph: gRoot, id: nB },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const wire = JSON.stringify(deltaToWire(result.delta));
    const decoded = decodeDelta(wire);
    expect(decoded.ok, !decoded.ok ? JSON.stringify(decoded.errors) : '').toBe(true);
    if (decoded.ok) expect(decoded.delta).toEqual(result.delta);
  });
});
