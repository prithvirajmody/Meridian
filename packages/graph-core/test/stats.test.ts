import { describe, expect, it } from 'vitest';
import { createGraphSpace, stats } from '../src/index.js';
import { demoSpace } from './helpers.js';

describe('stats', () => {
  it('is all zeros for an empty space', () => {
    expect(stats(createGraphSpace())).toEqual({
      graphs: 0,
      nodes: 0,
      edges: 0,
      roots: 0,
      maxDepth: 0,
      nodesWithDetail: 0,
      nodesByKind: {},
      edgesByKind: {},
    });
  });

  it('counts elements, kinds, and containment depth', () => {
    const s = stats(demoSpace());
    expect(s.graphs).toBe(3);
    expect(s.nodes).toBe(4);
    expect(s.edges).toBe(1);
    expect(s.roots).toBe(1);
    expect(s.maxDepth).toBe(3);
    expect(s.nodesWithDetail).toBe(2);
    expect(s.nodesByKind).toEqual({ 'demo:module': 2, 'demo:step': 2 });
    expect(s.edgesByKind).toEqual({ 'core:references': 1 });
  });

  it('emits kind histograms with sorted keys (stable --json output)', () => {
    const s = stats(demoSpace());
    expect(Object.keys(s.nodesByKind)).toEqual([...Object.keys(s.nodesByKind)].sort());
  });
});
