/**
 * 8F AiTrustController: proposals become graph structure only through the one
 * write path (`applyProposal`), tagged `origin:'ai'`. Human-in-the-loop by
 * default; auto-accept is a per-service opt-in; accept is async and cancellable;
 * rejection and budget-style failures write nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  addGraph,
  addNode,
  asGraphId,
  asNodeId,
  createGraphSpace,
  type GraphSpace,
  type SourceRef,
} from '@meridian/graph-core';
import { createStore, type GraphStore } from '@meridian/graph-store';
import type { AbstractionProposal } from '@meridian/abstraction';
import { AiTrustController } from '../src/ai/ai-trust-controller.js';
import { createStudioStore } from '../src/store.js';

const SRC: SourceRef = { origin: 'source', uri: 'test://c' };

/** Flat root graph of isolated nodes (no edges ⇒ any grouping is boundary-safe). */
function flatSpace(nodes: readonly string[]): GraphSpace {
  let s = addGraph(createGraphSpace(), { id: asGraphId('r'), label: 'r', domain: 'doc', provenance: SRC });
  for (const n of nodes) {
    s = addNode(s, asGraphId('r'), { id: asNodeId(n), kind: 'doc:node', label: n, provenance: SRC });
  }
  return s;
}

function clusterProposal(id: string, members: readonly string[], confidence?: number): AbstractionProposal {
  return {
    groups: [
      {
        id,
        label: 'Cluster',
        members,
        rationale: 'topical',
        ...(confidence !== undefined ? { confidence } : {}),
      },
    ],
  };
}

function harness(nodes = ['n1', 'n2', 'n3']) {
  const graph: GraphStore = createStore(flatSpace(nodes));
  const store = createStudioStore();
  const controller = new AiTrustController(store, () => graph);
  return { graph, store, controller };
}

describe('AiTrustController', () => {
  it('queues a proposal as pending (human-in-the-loop default) without writing', () => {
    const { graph, store, controller } = harness();
    const id = controller.submit({ service: 'clusterer', proposal: clusterProposal('g1', ['n1', 'n2'], 0.8) });
    const descriptor = store.getState().ai.proposals.find((p) => p.id === id)!;
    expect(descriptor.status).toBe('pending');
    expect(descriptor.minConfidence).toBe(0.8);
    // Nothing written yet.
    expect(graph.snapshot().graphs.get(asGraphId('r'))!.nodes.has(asNodeId('g1'))).toBe(false);
    expect(controller.pendingCount()).toBe(1);
  });

  it('accept commits a tagged AI-origin delta through the one write path', async () => {
    const { graph, store, controller } = harness();
    const id = controller.submit({ service: 'clusterer', proposal: clusterProposal('g1', ['n1', 'n2'], 0.8) });
    const outcome = await controller.accept(id);
    expect(outcome.ok).toBe(true);
    const cluster = graph.snapshot().graphs.get(asGraphId('r'))!.nodes.get(asNodeId('g1'))!;
    expect(cluster.provenance.origin).toBe('ai');
    expect(cluster.provenance.confidence).toBe(0.8);
    // Removed from the inbox on success.
    expect(store.getState().ai.proposals.find((p) => p.id === id)).toBeUndefined();
    expect(controller.pendingCount()).toBe(0);
  });

  it('reject writes nothing and drops the proposal', () => {
    const { graph, store, controller } = harness();
    const id = controller.submit({ service: 'clusterer', proposal: clusterProposal('g1', ['n1', 'n2'], 0.8) });
    controller.reject(id);
    expect(store.getState().ai.proposals).toHaveLength(0);
    expect(graph.snapshot().graphs.get(asGraphId('r'))!.nodes.has(asNodeId('g1'))).toBe(false);
    expect(controller.pendingCount()).toBe(0);
  });

  it('a cancel before the write leaves the graph untouched and the proposal pending', async () => {
    const { graph, store, controller } = harness();
    const id = controller.submit({ service: 'clusterer', proposal: clusterProposal('g1', ['n1', 'n2'], 0.8) });
    const abort = new AbortController();
    const pending = controller.accept(id, abort.signal);
    abort.abort(); // lands during the pre-write microtask yield
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    expect(outcome.errors).toContain('cancelled');
    expect(graph.snapshot().graphs.get(asGraphId('r'))!.nodes.has(asNodeId('g1'))).toBe(false);
    expect(store.getState().ai.proposals.find((p) => p.id === id)!.status).toBe('pending');
  });

  it('a rejected (invalid) proposal is marked failed with located errors, nothing written', async () => {
    const { graph, store, controller } = harness();
    // Reused member across two groups ⇒ applyProposal refuses up front.
    const proposal: AbstractionProposal = {
      groups: [
        { id: 'g1', label: 'A', members: ['n1', 'n2'], rationale: '', confidence: 0.5 },
        { id: 'g2', label: 'B', members: ['n2', 'n3'], rationale: '', confidence: 0.5 },
      ],
    };
    const id = controller.submit({ service: 'clusterer', proposal });
    const outcome = await controller.accept(id);
    expect(outcome.ok).toBe(false);
    expect(outcome.errors.join(' ')).toContain('member-reused');
    const descriptor = store.getState().ai.proposals.find((p) => p.id === id)!;
    expect(descriptor.status).toBe('failed');
    expect(graph.snapshot().graphs.get(asGraphId('r'))!.nodes.has(asNodeId('g1'))).toBe(false);
  });

  it('auto-accept is opt-in: enabling a service applies matching pending proposals', async () => {
    const { graph, store, controller } = harness();
    const id = controller.submit({ service: 'clusterer', proposal: clusterProposal('g1', ['n1', 'n2'], 0.9) });
    expect(store.getState().ai.proposals.find((p) => p.id === id)!.status).toBe('pending');

    controller.setAutoAccept('clusterer', { enabled: true, minConfidence: 0.8 });
    await Promise.resolve(); // let the queued accept run
    await Promise.resolve();
    expect(store.getState().ai.autoAccept.clusterer).toEqual({ enabled: true, minConfidence: 0.8 });
    expect(graph.snapshot().graphs.get(asGraphId('r'))!.nodes.has(asNodeId('g1'))).toBe(true);
  });

  it('auto-accept honours the confidence floor: below-floor proposals stay pending', async () => {
    const { graph, controller, store } = harness();
    controller.setAutoAccept('clusterer', { enabled: true, minConfidence: 0.8 });
    const id = controller.submit({ service: 'clusterer', proposal: clusterProposal('g1', ['n1', 'n2'], 0.5) });
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getState().ai.proposals.find((p) => p.id === id)!.status).toBe('pending');
    expect(graph.snapshot().graphs.get(asGraphId('r'))!.nodes.has(asNodeId('g1'))).toBe(false);
  });
});
