/**
 * End-to-end proof of the trust boundary (ADR-0031, ROADMAP P8 §12
 * "proposals → store → cut"): an AI service emits a *proposal*, `applyProposal`
 * turns it into ordinary op-deltas through the GraphStore's one write path, and
 * a later cut surfaces the new AI-origin structure carrying the provenance
 * quartet. AI never writes; it only proposes.
 */
import {
  asGraphId,
  asNodeId,
  addGraph,
  addNode,
  createGraphSpace,
  encode,
  type GraphSpace,
  type SourceRef,
} from '@meridian/graph-core';
import { applyProposal, buildCut, buildLevelChain } from '@meridian/abstraction';
import { createStore } from '@meridian/graph-store';
import type { AbstractionContext, AbstractionProvider } from '@meridian/plugin-api';
import type { MockCompletionHandler, MockEmbeddingHandler } from '@meridian/ai';
import { describe, expect, it } from 'vitest';
import { clusterNodes, clustersToProposal } from '../src/cluster.js';
import { summarizeAbstraction } from '../src/provider.js';
import { makeSession } from './helpers.js';

const SRC: SourceRef = { origin: 'source', uri: 'test://integration' };

function flatSpace(nodes: readonly string[]): GraphSpace {
  let s = addGraph(createGraphSpace(), { id: asGraphId('r'), label: 'r', domain: 'doc', provenance: SRC });
  for (const n of nodes) {
    s = addNode(s, asGraphId('r'), { id: asNodeId(n), kind: 'doc:node', label: n, provenance: SRC });
  }
  return s;
}

const CTX: AbstractionContext = { apiVersion: '1.0.0', log: { info: () => undefined, warn: () => undefined } };

const plantedEmbed: MockEmbeddingHandler = (req) =>
  req.input.map((t) => {
    const m = /^g(\d+)#(\d+)$/.exec(t)!;
    const v = new Array<number>(4).fill(0);
    v[Number(m[1])] = 1 + Number(m[2]) * 1e-9;
    return v;
  });

describe('cluster → proposal → store → cut', () => {
  it('applies embedding clusters as AI-origin nodes visible in a coarse cut', async () => {
    const store = createStore(flatSpace(['n0_0', 'n0_1', 'n1_0', 'n1_1']));
    const { session } = makeSession({ onEmbed: plantedEmbed });
    const { clusters } = await clusterNodes(
      session,
      [
        { id: 'n0_0', text: 'g0#0' },
        { id: 'n0_1', text: 'g0#1' },
        { id: 'n1_0', text: 'g1#0' },
        { id: 'n1_1', text: 'g1#1' },
      ],
      { k: 2, domain: 'doc' },
    );

    const r = applyProposal(store, clustersToProposal(clusters));
    expect(r.ok).toBe(true);

    // A coarse cut now shows exactly the two cluster nodes, each origin:'ai'.
    const space = store.snapshot();
    const chain = buildLevelChain(space);
    const cut = buildCut(space, chain, 0);
    expect(cut.members.length).toBe(2);
    for (const member of cut.members) {
      const node = space.graphs.get(asGraphId('r'))!.nodes.get(member)!;
      expect(node.provenance.origin).toBe('ai');
      expect(node.provenance).toMatchObject({
        providerId: 'embed',
        model: 'embed-model',
        promptVersion: 'embedding',
        inputHash: expect.any(String),
      });
      expect(node.provenance.confidence).toBeGreaterThan(0);
    }
  });
});

describe('summarize → proposal → store → cut', () => {
  it('stamps AI name, ai:summary, and provenance on the enriched cluster node', async () => {
    const store = createStore(flatSpace(['a', 'b']));
    const doc = encode(flatSpace(['a', 'b']));

    // A deterministic base grouping; the AI only names/summarizes it.
    const base: AbstractionProvider = {
      id: 'test:base',
      propose: () =>
        Promise.resolve({
          groups: [{ id: 'grp', label: 'floor label', members: ['a', 'b'], rationale: 'deterministic floor' }],
        }),
    };
    const onComplete: MockCompletionHandler = () => ({
      kind: 'json',
      value: { name: 'Authentication', summary: 'Login and session code.', confidence: 0.9 },
    });
    const { session } = makeSession({ onComplete });

    const { proposal, report } = await summarizeAbstraction({ session, base }, doc, CTX);
    expect(report.enriched).toBe(1);
    expect(proposal.groups[0]).toMatchObject({
      id: 'grp',
      label: 'Authentication',
      summary: 'Login and session code.',
      providerId: 'mock',
      promptVersion: '1',
    });

    const r = applyProposal(store, proposal);
    expect(r.ok).toBe(true);

    const node = store.snapshot().graphs.get(asGraphId('r'))!.nodes.get(asNodeId('grp'))!;
    expect(node.provenance).toMatchObject({ origin: 'ai', model: 'test-model', confidence: 0.9 });
    expect(node.attrs['ai:summary']).toBe('Login and session code.');
    expect(node.label).toBe('Authentication');
  });
});
