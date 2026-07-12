/**
 * Search over the P1 label-token index (ADR-0025): query tokenization,
 * AND-intersection, deterministic ranking, and context scoping — the fly-to
 * targeting substrate. Controller-level fly-to lives in the drill/nav suites.
 */
import { describe, expect, it } from 'vitest';
import { asNodeId } from '@meridian/graph-core';
import {
  buildLabelTokenIndex,
  searchLabels,
  tokenize,
  type LabelTokenIndex,
} from '../src/search.js';
import type { NodeId } from '@meridian/view-model';
import { buildSpace } from './helpers.js';

function idx(entries: Record<string, string[]>): LabelTokenIndex {
  const nodesByToken = new Map<string, Set<NodeId>>();
  for (const [token, ids] of Object.entries(entries)) {
    nodesByToken.set(token, new Set(ids.map((i) => asNodeId(i))));
  }
  return { nodesByToken };
}

describe('tokenize (P1 label contract)', () => {
  it('NFC-normalizes, lowercases, and splits on non-alphanumeric', () => {
    expect(tokenize('Hello, World! foo_bar')).toEqual(['hello', 'world', 'foo', 'bar']);
    expect(tokenize('   ')).toEqual([]);
  });
});

describe('searchLabels (ADR-0025)', () => {
  const index = idx({
    parser: ['n-parser', 'n-json-parser'],
    json: ['n-json-parser', 'n-json'],
    tree: ['n-tree'],
  });

  it('AND-intersects every query token', () => {
    expect(searchLabels(index, 'json parser').map((h) => h.node)).toEqual([asNodeId('n-json-parser')]);
  });

  it('ranks by matched-token count then NodeId ascending (deterministic)', () => {
    const hits = searchLabels(index, 'parser');
    expect(hits.map((h) => h.node)).toEqual([asNodeId('n-json-parser'), asNodeId('n-parser')]);
    expect(hits.every((h) => h.score === 1)).toBe(true);
  });

  it('an empty / all-stopword query returns nothing', () => {
    expect(searchLabels(index, '  ,, ')).toEqual([]);
  });

  it('an unmatched token returns nothing (intersection is empty)', () => {
    expect(searchLabels(index, 'json missing')).toEqual([]);
  });

  it('the allowed predicate scopes results to the current context', () => {
    const inContext = new Set([asNodeId('n-parser')]);
    expect(searchLabels(index, 'parser', (id) => inContext.has(id)).map((h) => h.node)).toEqual([
      asNodeId('n-parser'),
    ]);
  });
});

describe('buildLabelTokenIndex (headless equivalent of the P1 store index)', () => {
  it('indexes node labels by token over a real GraphSpace', () => {
    // helpers.buildSpace labels every node with its id.
    const space = buildSpace([{ id: 'parser', children: [{ id: 'json' }, { id: 'yaml' }] }]);
    const built = buildLabelTokenIndex(space);
    expect(searchLabels(built, 'parser').map((h) => h.node)).toEqual([asNodeId('parser')]);
    expect(searchLabels(built, 'json').map((h) => h.node)).toEqual([asNodeId('json')]);
    expect(searchLabels(built, 'missing')).toEqual([]);
  });
});
