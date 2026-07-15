/**
 * `applyProposal` round-trip (ROADMAP Phase 3 §6, §12): a proposal becomes
 * ordinary P1 deltas through the real GraphStore's one write path, and the new
 * containment is visible to a subsequent cut. Plus the failure fixtures:
 * boundary-crossing edges, unknown members, id collisions — each refused with a
 * located error, never half-applied.
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
  detailGraphOf,
  encode,
  type GraphSpace,
  type SourceRef,
} from '@meridian/graph-core';
import { createStore } from '@meridian/graph-store';
import {
  applyProposal,
  buildCut,
  buildLevelChain,
  containmentRollupProvider,
  type AbstractionProposal,
} from '../src/index.js';

const SRC: SourceRef = { origin: 'source', uri: 'test://apply' };

function flatSpace(nodes: readonly string[], edges: readonly [string, string, string][] = []): GraphSpace {
  let s = addGraph(createGraphSpace(), { id: asGraphId('r'), label: 'r', domain: 'doc', provenance: SRC });
  for (const n of nodes) s = addNode(s, asGraphId('r'), { id: asNodeId(n), kind: 'doc:node', label: n, provenance: SRC });
  for (const [eid, a, b] of edges) {
    s = addEdge(s, asGraphId('r'), { id: asEdgeId(eid), src: asNodeId(a), dst: asNodeId(b), kind: 'rel:x', provenance: SRC });
  }
  return s;
}

describe('applyProposal — AI provenance & attrs threading (ADR-0031)', () => {
  it('stamps the AI provenance quartet + confidence on the cluster node and its detail graph', () => {
    const store = createStore(flatSpace(['n1', 'n2']));
    const r = applyProposal(store, {
      groups: [
        {
          id: 'g',
          label: 'Auth',
          members: ['n1', 'n2'],
          rationale: 'topical',
          confidence: 0.8,
          providerId: 'anthropic',
          model: 'claude-opus-4-8',
          promptVersion: '3',
          inputHash: 'abc123',
        },
      ],
    });
    expect(r.ok).toBe(true);
    const space = store.snapshot();
    const clusterNode = space.graphs.get(asGraphId('r'))!.nodes.get(asNodeId('g'))!;
    expect(clusterNode.provenance).toEqual({
      origin: 'ai',
      providerId: 'anthropic',
      model: 'claude-opus-4-8',
      promptVersion: '3',
      inputHash: 'abc123',
      confidence: 0.8,
    });
    // The detail graph carries the same AI provenance.
    const detail = detailGraphOf(space, clusterNode)!;
    expect(detail.meta.provenance.origin).toBe('ai');
    expect(detail.meta.provenance.providerId).toBe('anthropic');
  });

  it('types the group node with the proposal kind, defaulting to core:cluster (9C)', () => {
    const store = createStore(flatSpace(['n1', 'n2', 'n3', 'n4']));
    const r = applyProposal(store, {
      groups: [
        { id: 'g1', label: 'Topic', members: ['n1', 'n2'], rationale: '', kind: 'conv:topic' },
        { id: 'g2', label: 'Plain', members: ['n3', 'n4'], rationale: '' },
      ],
    });
    expect(r.ok).toBe(true);
    const root = store.snapshot().graphs.get(asGraphId('r'))!;
    expect(root.nodes.get(asNodeId('g1'))!.kind).toBe('conv:topic');
    expect(root.nodes.get(asNodeId('g2'))!.kind).toBe('core:cluster');
  });

  it('maps summary → ai:summary and passes through provider attrs', () => {
    const store = createStore(flatSpace(['n1', 'n2']));
    const r = applyProposal(store, {
      groups: [
        {
          id: 'g',
          label: 'Auth',
          members: ['n1', 'n2'],
          rationale: '',
          confidence: 0.6,
          summary: 'Authentication and session code.',
          attrs: { 'ai:evidence': 'n1,n2' },
        },
      ],
    });
    expect(r.ok).toBe(true);
    const clusterNode = store.snapshot().graphs.get(asGraphId('r'))!.nodes.get(asNodeId('g'))!;
    expect(clusterNode.attrs).toEqual({
      'ai:summary': 'Authentication and session code.',
      'ai:evidence': 'n1,n2',
    });
  });

  it('a deterministic proposal (no AI fields) stays origin:derived with empty attrs', () => {
    const store = createStore(flatSpace(['n1', 'n2']));
    const r = applyProposal(store, {
      groups: [{ id: 'g', label: 'g', members: ['n1', 'n2'], rationale: '' }],
    });
    expect(r.ok).toBe(true);
    const clusterNode = store.snapshot().graphs.get(asGraphId('r'))!.nodes.get(asNodeId('g'))!;
    expect(clusterNode.provenance).toEqual({ origin: 'derived' });
    expect(clusterNode.attrs).toEqual({});
  });
});

describe('applyProposal — round-trip through a real GraphStore', () => {
  it('groups two nodes (with an internal edge); the new containment shows in a later cut', () => {
    const store = createStore(flatSpace(['n1', 'n2', 'n3'], [['e0', 'n1', 'n2']]));
    const proposal: AbstractionProposal = {
      groups: [{ id: 'grp1', label: 'Grp', members: ['n1', 'n2'], rationale: 'test' }],
    };

    const result = applyProposal(store, proposal);
    expect(result.ok).toBe(true);

    const space = store.snapshot();
    // The group node exists in the root graph with a detail graph…
    const rootGraph = space.graphs.get(asGraphId('r'))!;
    const groupNode = rootGraph.nodes.get(asNodeId('grp1'))!;
    expect(groupNode.kind).toBe('core:cluster');
    const detail = detailGraphOf(space, groupNode)!;
    // …holding exactly n1, n2, and the relocated internal edge.
    expect([...detail.nodes.keys()].map(String).sort()).toEqual(['n1', 'n2']);
    expect([...detail.edges.keys()].map(String)).toEqual(['e0']);
    // n1/n2 are no longer in the root graph.
    expect(rootGraph.nodes.has(asNodeId('n1'))).toBe(false);

    // A cut sees the new hierarchy: level 0 = {grp1, n3}; level 1 descends.
    const chain = buildLevelChain(space);
    const l0 = buildCut(space, chain, 0);
    expect([...l0.members].map(String).sort()).toEqual(['grp1', 'n3']);
    const l1 = buildCut(space, chain, 1);
    expect([...l1.members].map(String).sort()).toEqual(['n1', 'n2', 'n3']);
    expect(l1.coverage.covers).toBe(true);
  });

  it('the delta went through the op-based write path (an invertible delta)', () => {
    const store = createStore(flatSpace(['n1', 'n2']));
    const r = applyProposal(store, { groups: [{ id: 'g', label: 'g', members: ['n1', 'n2'], rationale: '' }] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.delta.ops.length).toBeGreaterThan(0);
      expect(r.changes.touched.graphs.size).toBeGreaterThan(0);
    }
  });
});

describe('applyProposal — provider → proposal → store', () => {
  it('a containment-rollup proposal applies end-to-end', async () => {
    const base = flatSpace(['a', 'b', 'c'], [['e0', 'a', 'b']]); // {a,b} one component
    const store = createStore(base);
    const proposal = await containmentRollupProvider.propose(encode(base), {
      apiVersion: '1.0.0',
      log: { info: () => undefined, warn: () => undefined },
    });
    expect(proposal.groups).toHaveLength(1);
    const r = applyProposal(store, proposal);
    expect(r.ok).toBe(true);
    // The component became a group; a coarse cut now has fewer nodes than base.
    const chain = buildLevelChain(store.snapshot());
    const coarse = buildCut(store.snapshot(), chain, 0);
    expect(coarse.members.length).toBe(2); // {group, c}
  });
});

describe('applyProposal — failure fixtures, refused with located errors', () => {
  it('refuses a group whose members have edges to non-members (no portals in v1)', () => {
    const store = createStore(flatSpace(['n1', 'n2', 'n3'], [['e0', 'n1', 'n3']]));
    const r = applyProposal(store, { groups: [{ id: 'g', label: 'g', members: ['n1', 'n2'], rationale: '' }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.code).toBe('crosses-boundary');
    // Nothing was written.
    expect(store.snapshot().graphs.get(asGraphId('r'))!.nodes.has(asNodeId('g'))).toBe(false);
  });

  it('reports an unknown member', () => {
    const store = createStore(flatSpace(['n1']));
    const r = applyProposal(store, { groups: [{ id: 'g', label: 'g', members: ['n1', 'nope'], rationale: '' }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === 'unknown-member')).toBe(true);
  });

  it('reports an id collision with an existing node', () => {
    const store = createStore(flatSpace(['n1', 'n2']));
    const r = applyProposal(store, { groups: [{ id: 'n1', label: 'g', members: ['n2'], rationale: '' }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === 'id-collision')).toBe(true);
  });

  it('reports a member reused across two groups', () => {
    const store = createStore(flatSpace(['n1', 'n2', 'n3']));
    const r = applyProposal(store, {
      groups: [
        { id: 'g1', label: 'g1', members: ['n1', 'n2'], rationale: '' },
        { id: 'g2', label: 'g2', members: ['n2', 'n3'], rationale: '' },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === 'member-reused')).toBe(true);
  });
});
