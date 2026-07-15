import {
  asGraphId,
  type AttrBag,
  type GraphSpace,
  type SemanticNode,
  type SourceRef,
} from '@meridian/graph-core';
import { describe, expect, it } from 'vitest';
import { buildProjectionModel, type TemporalDomainHints } from '../src/index.js';
import { lodOf, n } from './helpers.js';

const SOURCE: SourceRef = { origin: 'source' };
const HINTS: TemporalDomainHints = {
  startAttribute: 't:start',
  endAttribute: 't:end',
  laneAttribute: 't:lane',
};

function member(id: string, attrs: AttrBag = {}, detail?: string): SemanticNode {
  return {
    id: n(id),
    label: id,
    kind: 'test:item',
    attrs,
    provenance: SOURCE,
    ...(detail === undefined ? {} : { detail: { graph: asGraphId(detail) } }),
  };
}

function space(graphs: Readonly<Record<string, readonly SemanticNode[]>>): GraphSpace {
  return {
    graphs: new Map(
      Object.entries(graphs).map(([graphId, nodes]) => [
        asGraphId(graphId),
        {
          id: asGraphId(graphId),
          meta: { label: graphId, domain: 'test', provenance: SOURCE },
          nodes: new Map(nodes.map((node) => [node.id, node])),
          edges: new Map(),
        },
      ]),
    ),
    roots: [asGraphId('g-root')],
  };
}

function temporalOf(snapshot: GraphSpace, members: readonly string[]) {
  const model = buildProjectionModel(snapshot, lodOf(members), { temporal: HINTS });
  return {
    model,
    extent: (id: string) => model.nodes.find((node) => node.id === n(id))?.temporal,
  };
}

describe('buildProjectionModel temporal normalization (ADR-0037)', () => {
  it('normalizes ISO-8601 strings, epoch-seconds numbers, and epoch-seconds strings', () => {
    const snapshot = space({
      'g-root': [
        member('iso', { 't:start': '2026-07-15T12:30:00Z' }),
        member('epoch', { 't:start': 1_750_000_000 }),
        member('epoch-string', { 't:start': '1750000000.5' }),
      ],
    });
    const { model, extent } = temporalOf(snapshot, ['iso', 'epoch', 'epoch-string']);

    expect(extent('iso')).toEqual({
      start: Date.parse('2026-07-15T12:30:00Z'),
      end: Date.parse('2026-07-15T12:30:00Z'),
    });
    expect(extent('epoch')).toEqual({ start: 1_750_000_000_000, end: 1_750_000_000_000 });
    expect(extent('epoch-string')).toEqual({ start: 1_750_000_000_500, end: 1_750_000_000_500 });
    expect(model.diagnostics).toEqual([]);
    expect(model.domainMeta.temporal).toEqual(HINTS);
  });

  it('uses a declared end attribute and treats an end before start as a located diagnostic', () => {
    const snapshot = space({
      'g-root': [
        member('range', { 't:start': 100, 't:end': 250 }),
        member('inverted', { 't:start': 100, 't:end': 50 }),
      ],
    });
    const { model, extent } = temporalOf(snapshot, ['range', 'inverted']);

    expect(extent('range')).toEqual({ start: 100_000, end: 250_000 });
    expect(extent('inverted')).toEqual({ start: 100_000, end: 100_000 });
    expect(model.diagnostics).toEqual([
      {
        code: 'invalid-temporal-value',
        nodeId: n('inverted'),
        attribute: 't:end',
        message: expect.stringContaining('t:end'),
      },
    ]);
  });

  it('reports invalid values as located diagnostics and leaves those nodes atemporal', () => {
    const snapshot = space({
      'g-root': [
        member('bad-string', { 't:start': 'not a timestamp' }),
        member('bad-type', { 't:start': true }),
        member('bad-number', { 't:start': Number.POSITIVE_INFINITY }),
        member('good', { 't:start': 7 }),
      ],
    });
    const { model, extent } = temporalOf(snapshot, [
      'bad-string',
      'bad-type',
      'bad-number',
      'good',
    ]);

    expect(extent('bad-string')).toBeNull();
    expect(extent('bad-type')).toBeNull();
    expect(extent('bad-number')).toBeNull();
    expect(extent('good')).toEqual({ start: 7_000, end: 7_000 });
    expect(model.diagnostics.map((diagnostic) => diagnostic.nodeId)).toEqual([
      n('bad-number'),
      n('bad-string'),
      n('bad-type'),
    ]);
    expect(structuredClone(model)).toEqual(model);
  });

  it('rolls descendant times up into an aggregate extent for undeclared containers', () => {
    const snapshot = space({
      'g-root': [member('session', {}, 'g-session')],
      'g-session': [member('exchange', {}, 'g-exchange'), member('untimed', {})],
      'g-exchange': [
        member('m1', { 't:start': 100 }),
        member('m2', { 't:start': 300, 't:end': 400 }),
      ],
    });
    const { extent } = temporalOf(snapshot, ['session']);

    expect(extent('session')).toEqual({ start: 100_000, end: 400_000 });
  });

  it('is atemporal without hints and honours options.temporal over domainMeta', () => {
    const snapshot = space({
      'g-root': [member('a', { 't:start': 100, 'other:when': 200 })],
    });
    const plain = buildProjectionModel(snapshot, lodOf(['a']));
    expect(plain.nodes[0]!.temporal).toBeNull();
    expect(plain.diagnostics).toEqual([]);

    const overridden = buildProjectionModel(snapshot, lodOf(['a']), {
      domainMeta: { domain: 'test', label: 'Test', temporal: HINTS },
      temporal: { startAttribute: 'other:when' },
    });
    expect(overridden.nodes[0]!.temporal).toEqual({ start: 200_000, end: 200_000 });
    expect(overridden.domainMeta.temporal).toEqual({ startAttribute: 'other:when' });
  });
});
