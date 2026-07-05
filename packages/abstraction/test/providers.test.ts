/**
 * Deterministic AbstractionProviders (3D). Containment-rollup groups connected
 * components; degree/size-collapse gathers low-degree satellites around a hub.
 * Both are pure (same input → identical proposal) and structurally implement
 * the real plugin-api `AbstractionProvider` contract.
 */
import { describe, expect, it } from 'vitest';
import {
  addEdge,
  addGraph,
  addNode,
  asEdgeId,
  asGraphId,
  asNodeId,
  createGraphSpace,
  encode,
  type GraphSpace,
  type SourceRef,
} from '@meridian/graph-core';
import type { AbstractionProvider as PluginAbstractionProvider } from '@meridian/plugin-api';
import {
  containmentRollupProvider,
  degreeSizeCollapseProvider,
  type AbstractionContext,
} from '../src/index.js';

const SRC: SourceRef = { origin: 'source', uri: 'test://providers' };
const ctx: AbstractionContext = { apiVersion: '1.0.0', log: { info: () => undefined, warn: () => undefined } };

function flat(nodes: readonly string[], edges: readonly [string, string][]): GraphSpace {
  let s = addGraph(createGraphSpace(), { id: asGraphId('g'), label: 'g', domain: 'doc', provenance: SRC });
  for (const n of nodes) s = addNode(s, asGraphId('g'), { id: asNodeId(n), kind: 'doc:node', label: n, provenance: SRC });
  let i = 0;
  for (const [a, b] of edges) {
    s = addEdge(s, asGraphId('g'), { id: asEdgeId(`e${i++}`), src: asNodeId(a), dst: asNodeId(b), kind: 'rel:x', provenance: SRC });
  }
  return s;
}

describe('containment-rollup provider — connected components', () => {
  it('proposes one group per multi-node component, singletons left alone', async () => {
    const doc = encode(flat(['a', 'b', 'c', 'd', 'e'], [['a', 'b'], ['c', 'd']]));
    const { groups } = await containmentRollupProvider.propose(doc, ctx);
    expect(groups).toHaveLength(2);
    const memberSets = groups.map((g) => [...g.members].sort());
    expect(memberSets).toContainEqual(['a', 'b']);
    expect(memberSets).toContainEqual(['c', 'd']);
    // 'e' is a singleton → not grouped.
    expect(groups.flatMap((g) => g.members)).not.toContain('e');
  });

  it('is deterministic (same doc → identical proposal)', async () => {
    const doc = encode(flat(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c']]));
    const p1 = await containmentRollupProvider.propose(doc, ctx);
    const p2 = await containmentRollupProvider.propose(doc, ctx);
    expect(p1).toEqual(p2);
    expect(p1.groups[0]!.members).toEqual(['a', 'b', 'c']); // one 3-node component
  });
});

describe('degree/size-collapse provider — satellites around a hub', () => {
  it('groups low-degree satellites under their hub', async () => {
    // h has degree 3 (hub); s1,s2,s3 each degree 1 (satellites); iso is isolated.
    const doc = encode(flat(['h', 's1', 's2', 's3', 'iso'], [['h', 's1'], ['h', 's2'], ['h', 's3']]));
    const { groups } = await degreeSizeCollapseProvider.propose(doc, ctx);
    expect(groups).toHaveLength(1);
    expect([...groups[0]!.members].sort()).toEqual(['h', 's1', 's2', 's3']);
  });

  it('proposes nothing when there is no hub', async () => {
    const doc = encode(flat(['a', 'b'], [['a', 'b']])); // both degree 1, no hub
    const { groups } = await degreeSizeCollapseProvider.propose(doc, ctx);
    expect(groups).toEqual([]);
  });
});

describe('structural conformance to the plugin-api contract', () => {
  it('both providers are assignable to plugin-api AbstractionProvider', () => {
    const a: PluginAbstractionProvider = containmentRollupProvider;
    const b: PluginAbstractionProvider = degreeSizeCollapseProvider;
    expect(a.id).toBe('core:containment-rollup');
    expect(b.id).toBe('core:degree-collapse');
  });
});
