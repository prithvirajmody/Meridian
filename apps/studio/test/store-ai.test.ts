/**
 * 8F AI-trust store slice + commands: provenance view, AI-origin summary, the
 * proposal inbox lifecycle, and the per-service auto-accept opt-in.
 */
import { describe, expect, it } from 'vitest';
import {
  createStudioStore,
  INITIAL_AI_TRUST_STATE,
  StudioStoreCommands,
  type PendingProposal,
} from '../src/store.js';

function proposal(id: string, over: Partial<PendingProposal> = {}): PendingProposal {
  return {
    id,
    service: 'summarizer',
    title: '2 groups',
    groupCount: 2,
    minConfidence: 0.7,
    status: 'pending',
    errors: [],
    receivedAtMs: 0,
    ...over,
  };
}

describe('AI-trust store slice', () => {
  it('initializes to the empty, human-in-the-loop default (view=all, no auto-accept)', () => {
    const store = createStudioStore();
    expect(store.getState().ai).toEqual(INITIAL_AI_TRUST_STATE);
    expect(store.getState().ai.provenanceView).toBe('all');
    expect(store.getState().ai.autoAccept).toEqual({});
  });

  it('toggles the provenance view idempotently', () => {
    const store = createStudioStore();
    const cmd = new StudioStoreCommands(store);
    cmd.setProvenanceView('evidence-only');
    expect(store.getState().ai.provenanceView).toBe('evidence-only');
    const ref = store.getState().ai;
    cmd.setProvenanceView('evidence-only'); // no-op, no new object
    expect(store.getState().ai).toBe(ref);
    cmd.setProvenanceView('all');
    expect(store.getState().ai.provenanceView).toBe('all');
  });

  it('records the AI-origin summary', () => {
    const store = createStudioStore();
    new StudioStoreCommands(store).setAiOriginSummary({ aiNodeCount: 3, aiNodeIds: ['x', 'y', 'z'] });
    expect(store.getState().ai.summary).toEqual({ aiNodeCount: 3, aiNodeIds: ['x', 'y', 'z'] });
  });

  it('upserts, patches status, and removes proposals by id', () => {
    const store = createStudioStore();
    const cmd = new StudioStoreCommands(store);
    cmd.upsertProposal(proposal('a'));
    cmd.upsertProposal(proposal('b'));
    expect(store.getState().ai.proposals.map((p) => p.id)).toEqual(['a', 'b']);

    // upsert replaces in place (no duplicate, order preserved).
    cmd.upsertProposal(proposal('a', { title: 'renamed' }));
    expect(store.getState().ai.proposals).toHaveLength(2);
    expect(store.getState().ai.proposals[0]!.title).toBe('renamed');

    cmd.setProposalStatus('b', 'failed', ['[empty-group] boom']);
    const b = store.getState().ai.proposals.find((p) => p.id === 'b')!;
    expect(b.status).toBe('failed');
    expect(b.errors).toEqual(['[empty-group] boom']);

    // status patch for an unknown id is a no-op.
    const ref = store.getState().ai.proposals;
    cmd.setProposalStatus('missing', 'accepted');
    expect(store.getState().ai.proposals).toBe(ref);

    cmd.removeProposal('a');
    expect(store.getState().ai.proposals.map((p) => p.id)).toEqual(['b']);
  });

  it('sets a per-service auto-accept opt-in without touching other services', () => {
    const store = createStudioStore();
    const cmd = new StudioStoreCommands(store);
    cmd.setAutoAccept('summarizer', { enabled: true, minConfidence: 0.8 });
    cmd.setAutoAccept('clusterer', { enabled: false });
    expect(store.getState().ai.autoAccept).toEqual({
      summarizer: { enabled: true, minConfidence: 0.8 },
      clusterer: { enabled: false },
    });
  });

  it('resets summary + inbox on a new corpus but keeps view/auto-accept preferences', () => {
    const store = createStudioStore();
    const cmd = new StudioStoreCommands(store);
    cmd.setProvenanceView('evidence-only');
    cmd.setAutoAccept('summarizer', { enabled: true });
    cmd.upsertProposal(proposal('a'));
    cmd.setAiOriginSummary({ aiNodeCount: 2, aiNodeIds: ['x', 'y'] });

    cmd.beginOpen({ generation: 2, name: 'next.md', bytes: 10 });

    const ai = store.getState().ai;
    expect(ai.proposals).toEqual([]);
    expect(ai.summary).toEqual({ aiNodeCount: 0, aiNodeIds: [] });
    expect(ai.provenanceView).toBe('evidence-only'); // preference persists
    expect(ai.autoAccept).toEqual({ summarizer: { enabled: true } });
  });
});
