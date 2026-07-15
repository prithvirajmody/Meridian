/**
 * 8F end-to-end through the real Studio pipeline: accepting an AI proposal makes
 * an AI-origin node appear in the cut, the store's AI-origin summary reflects it,
 * and the provenance filter ("evidence-only") removes it from the published
 * model — a pure view op that leaves the store untouched.
 */
import { describe, expect, it } from 'vitest';
import type { AbstractionProposal } from '@meridian/abstraction';
import { StudioSession } from '../src/studio-session.js';
import { createStudioStore } from '../src/store.js';
import { ManualClock } from '../src/transition/clock.js';

// A flat paragraph doc: the nodes live in one graph (no headings ⇒ no per-section
// subgraphs), and with no links there are no edges — so grouping two of them is a
// boundary-safe proposal.
const FLAT_DOC = 'First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.\n';

/** Let the fire-and-forget replan finish laying out, then settle its flight. */
async function settle(session: StudioSession, clock: ManualClock): Promise<void> {
  // Flush microtasks/timers so spaceMutated's async layout completes and the
  // flight exists, then drive the manual clock past the transition duration.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const nav = session.nav();
  if (nav !== null) {
    clock.advance(1000);
    nav.tick();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('StudioSession AI trust surface (end-to-end)', () => {
  it('accept → AI-origin node in cut → summary reflects it → filter hides it', async () => {
    const store = createStudioStore();
    const clock = new ManualClock();
    const session = new StudioSession(store, { clock });
    try {
      await session.openText('flat.md', FLAT_DOC);
      expect(store.getState().phase).toBe('ready');
      expect(store.getState().ai.summary.aiNodeCount).toBe(0);

      const members = store.getState().renderModel!.nodeIds.slice(0, 2);
      expect(members.length).toBe(2);

      const proposal: AbstractionProposal = {
        groups: [
          {
            id: 'ai-cluster-1',
            label: 'Topic',
            members: [...members],
            rationale: 'topical',
            confidence: 0.82,
            model: 'claude-opus-4-8',
          },
        ],
      };
      const id = session.aiTrust.submit({ service: 'summarizer', proposal });
      const outcome = await session.aiTrust.accept(id);
      expect(outcome.ok, outcome.errors.join('; ')).toBe(true);
      await settle(session, clock);

      // The AI cluster node is now in the cut and summarized.
      const summary = store.getState().ai.summary;
      expect(summary.aiNodeCount).toBeGreaterThan(0);
      expect(summary.aiNodeIds).toContain('ai-cluster-1');
      const fullCount = store.getState().renderModel!.nodeIds.length;
      expect(store.getState().renderModel!.nodeIds).toContain('ai-cluster-1');

      // Evidence-only hides all AI-origin structure from the published model.
      session.setProvenanceView('evidence-only');
      expect(store.getState().ai.provenanceView).toBe('evidence-only');
      expect(store.getState().renderModel!.nodeIds).not.toContain('ai-cluster-1');
      expect(store.getState().renderModel!.nodeIds.length).toBe(fullCount - summary.aiNodeCount);
      expect(store.getState().projectionModel?.renderModel).toBe(store.getState().renderModel);
      expect(store.getState().projectionModel?.nodes.map((node) => node.id).sort()).toEqual(
        [...store.getState().renderModel!.nodeIds].sort(),
      );
      expect(store.getState().projectionModel?.inducedEdges.every((edge) =>
        store.getState().renderModel!.edgeKeys.includes(`${edge.src}→${edge.dst}→${edge.kind}`),
      )).toBe(true);

      // Toggling back restores the full model — nothing was lost from the store.
      session.setProvenanceView('all');
      expect(store.getState().renderModel!.nodeIds).toContain('ai-cluster-1');
      expect(store.getState().renderModel!.nodeIds.length).toBe(fullCount);
    } finally {
      await session.destroy();
    }
  });
});
