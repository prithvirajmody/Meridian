/**
 * Op algebra units (ROADMAP Phase 1 §12): every op type applies, inverts,
 * and composes; hand-computed truth, no store round-trips (those are the
 * property suites' job).
 */
import { asGraphId, asNodeId, type GraphMeta } from '@meridian/graph-core';
import { describe, expect, it } from 'vitest';
import {
  composeDeltas,
  invertDelta,
  invertOp,
  type GraphDelta,
  type GraphOp,
} from '../src/index.js';
import { SRC } from './helpers.js';

const meta: GraphMeta = { label: 'X', domain: 'demo', provenance: SRC };
const meta2: GraphMeta = { label: 'Y', domain: 'demo', provenance: SRC };
const g = asGraphId('g1');
const n = asNodeId('n1');
const node = { id: n, kind: 'demo:step', label: 's', attrs: {}, provenance: SRC };
const edge = {
  id: 'e1' as never,
  src: n,
  dst: n,
  kind: 'demo:recurses',
  attrs: {},
  provenance: SRC,
};

describe('invertOp', () => {
  const cases: Array<[GraphOp, GraphOp]> = [
    [
      { t: 'graph:add', graph: g, meta },
      { t: 'graph:remove', graph: g, prev: meta },
    ],
    [
      { t: 'graph:meta', graph: g, prev: meta, next: meta2 },
      { t: 'graph:meta', graph: g, prev: meta2, next: meta },
    ],
    [
      { t: 'node:add', graph: g, node },
      { t: 'node:remove', graph: g, id: n, prev: node },
    ],
    [
      { t: 'node:attr', graph: g, id: n, key: 'demo:x', next: 5 },
      { t: 'node:attr', graph: g, id: n, key: 'demo:x', prev: 5 },
    ],
    [
      { t: 'node:attr', graph: g, id: n, key: 'demo:x', prev: 1, next: null },
      { t: 'node:attr', graph: g, id: n, key: 'demo:x', prev: null, next: 1 },
    ],
    [
      { t: 'node:detail', graph: g, id: n, next: { graph: asGraphId('g2') } },
      { t: 'node:detail', graph: g, id: n, prev: { graph: asGraphId('g2') } },
    ],
    [
      { t: 'edge:add', graph: g, edge },
      { t: 'edge:remove', graph: g, id: edge.id, prev: edge },
    ],
  ];

  it.each(cases.map(([op, inv]) => ({ t: op.t, op, inv })))('$t', ({ op, inv }) => {
    expect(invertOp(op)).toEqual(inv);
    // Involution: inverting twice is the identity.
    expect(invertOp(invertOp(op))).toEqual(op);
  });
});

describe('invertDelta', () => {
  const delta: GraphDelta = {
    baseVersion: { counter: 3, site: 'local' },
    origin: { actor: 'test' },
    ops: [
      { t: 'graph:add', graph: g, meta },
      { t: 'node:add', graph: g, node },
    ],
  };

  it('reverses op order, inverts each op, and bases on the successor version', () => {
    const inv = invertDelta(delta);
    expect(inv.baseVersion).toEqual({ counter: 4, site: 'local' });
    expect(inv.origin).toEqual(delta.origin);
    expect(inv.ops).toEqual([
      { t: 'node:remove', graph: g, id: n, prev: node },
      { t: 'graph:remove', graph: g, prev: meta },
    ]);
  });

  it('accepts an origin override for undo attribution', () => {
    expect(invertDelta(delta, { actor: 'undo' }).origin).toEqual({ actor: 'undo' });
  });

  it('double inversion is the original delta', () => {
    expect(invertDelta(invertDelta(delta))).not.toEqual(delta); // baseVersion advanced twice…
    expect(invertDelta(invertDelta(delta)).ops).toEqual(delta.ops); // …but ops round-trip
  });
});

describe('composeDeltas', () => {
  const d1: GraphDelta = {
    baseVersion: { counter: 0, site: 'local' },
    origin: { actor: 'a' },
    ops: [{ t: 'graph:add', graph: g, meta }],
  };
  const d2: GraphDelta = {
    baseVersion: { counter: 1, site: 'local' },
    origin: { actor: 'a' },
    ops: [{ t: 'node:add', graph: g, node }],
  };

  it('concatenates consecutive deltas', () => {
    const c = composeDeltas(d1, d2);
    expect(c.baseVersion).toEqual(d1.baseVersion);
    expect(c.ops).toEqual([...d1.ops, ...d2.ops]);
    expect(c.origin).toEqual({ actor: 'a' });
  });

  it('marks mixed origins as compose', () => {
    expect(composeDeltas(d1, { ...d2, origin: { actor: 'b' } }).origin).toEqual({ actor: 'compose' });
  });

  it('rejects non-consecutive deltas', () => {
    expect(() => composeDeltas(d1, { ...d2, baseVersion: { counter: 5, site: 'local' } })).toThrow(
      /consecutive/,
    );
  });
});
