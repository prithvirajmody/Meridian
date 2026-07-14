import { expect, test, type Page } from '@playwright/test';
import { boot, settleFrames } from './support.js';

/**
 * 8F AI human-trust surface, end-to-end through the real Studio UI (ADR-0031).
 * Everything is driven from deterministic in-app fixtures: a flat markdown doc
 * opened via the test seam, and AI proposals submitted through the same
 * `aiSubmitProposal` seam an AI service will use in 8D/8E — so no network is
 * touched and no AI SDK is loaded. Accept/reject/auto-accept/filter are exercised
 * as real user interactions (panel buttons, checkbox, toggle); the only non-click
 * path is cancellation, whose in-flight window is a single microtask and so is
 * driven through the signalled-accept seam (see runtime.ts).
 *
 * A flat paragraph doc: no headings ⇒ one graph, no links ⇒ no edges, so grouping
 * leaves is a boundary-safe proposal whose rollup node lands in the cut. Five
 * paragraphs leave enough ungrouped leaves to place two disjoint clusters.
 */
const FLAT_DOC = Array.from({ length: 5 }, (_, i) => `Paragraph ${i + 1} here.`).join('\n\n') + '\n';

async function openFlat(page: Page): Promise<void> {
  await page.evaluate((text) => window.__MERIDIAN_STUDIO__!.openText('flat.md', text), FLAT_DOC);
  await expect(page.getByTestId('pipeline-phase')).toHaveText('ready', { timeout: 30_000 });
  await page.waitForFunction(
    () => (window.__MERIDIAN_STUDIO__?.state().rendererStats?.frameCount ?? 0) > 0,
    undefined,
    { timeout: 30_000 },
  );
}

/** Submit a boundary-safe cluster proposal grouping the cut's first two leaves.
 * The group id becomes the accepted AI-origin node id. Returns the proposal id. */
async function submitCluster(
  page: Page,
  opts: { service: string; groupId: string; title: string; confidence: number; fromEnd?: boolean },
): Promise<string> {
  return page.evaluate(({ service, groupId, title, confidence, fromEnd }) => {
    const api = window.__MERIDIAN_STUDIO__!;
    // Only ungrouped leaves are boundary-safe members; `fromEnd` picks a disjoint
    // pair so a second cluster does not overlap an already-accepted one.
    const leaves = api.state().nodeIds.filter((id) => !id.startsWith('ai-'));
    const members = fromEnd ? leaves.slice(-2) : leaves.slice(0, 2);
    return api.aiSubmitProposal({
      service,
      title,
      proposal: {
        groups: [
          { id: groupId, label: 'Topic', members, rationale: 'topical', confidence, model: 'claude-opus-4-8' },
        ],
      },
    });
  }, opts);
}

/** Wait until the accepted proposal's replan has republished the model (the
 * AI-origin summary reflects it) and any resulting transition has settled. */
async function waitForAiStructure(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__MERIDIAN_STUDIO__!.aiState().aiNodeCount > 0, undefined, {
    timeout: 15_000,
  });
  await page.waitForFunction(() => !window.__MERIDIAN_STUDIO__!.transitionActive(), undefined, {
    timeout: 15_000,
  });
  // Frame the whole graph so the settled AI-origin node projects on-screen.
  await page.evaluate(() => window.__MERIDIAN_STUDIO__!.fit());
  await settleFrames(page);
}

test('proposals are human-in-the-loop by default: no AI structure until a human accepts', async ({
  page,
}) => {
  await boot(page);
  await openFlat(page);

  await expect(page.getByTestId('ai-proposals-empty')).toBeVisible();
  await expect(page.getByTestId('ai-origin-count')).toHaveText('0 AI');

  const id = await submitCluster(page, {
    service: 'summarizer',
    groupId: 'ai-cluster-1',
    title: 'Topic cluster',
    confidence: 0.82,
  });

  // The proposal sits pending and writes nothing: no AI-origin node, no badge.
  await expect(page.getByTestId(`proposal-${id}`)).toHaveAttribute('data-status', 'pending');
  await expect(page.getByTestId('ai-proposals-count')).toHaveText('(1)');
  await expect(page.getByTestId(`proposal-accept-${id}`)).toBeVisible();
  await expect(page.getByTestId(`proposal-reject-${id}`)).toBeVisible();
  await expect(page.getByTestId('ai-origin-count')).toHaveText('0 AI');
  await expect(page.getByTestId('ai-origin-badge')).toHaveCount(0);
  expect(await page.evaluate(() => window.__MERIDIAN_STUDIO__!.aiState().aiNodeCount)).toBe(0);
  // Auto-accept is opt-in and starts off for this service.
  await expect(page.getByTestId('auto-accept-toggle-summarizer')).not.toBeChecked();
});

test('accepting a proposal from the panel adds visibly-badged AI-origin structure', async ({
  page,
}) => {
  await boot(page);
  await openFlat(page);

  const id = await submitCluster(page, {
    service: 'summarizer',
    groupId: 'ai-cluster-1',
    title: 'Topic cluster',
    confidence: 0.82,
  });

  await page.getByTestId(`proposal-accept-${id}`).click();

  // Removed from the inbox on commit; the graph now carries one AI-origin node.
  await expect(page.getByTestId(`proposal-${id}`)).toHaveCount(0);
  await waitForAiStructure(page);

  await expect(page.getByTestId('ai-origin-count')).toHaveText('1 AI');
  const badge = page.getByTestId('ai-origin-badge');
  await expect(badge).toHaveCount(1);
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute('data-node-id', 'ai-cluster-1');
  expect(
    await page.evaluate(() => window.__MERIDIAN_STUDIO__!.aiState().aiNodeIds),
  ).toContain('ai-cluster-1');
});

test('rejecting a proposal writes nothing', async ({ page }) => {
  await boot(page);
  await openFlat(page);

  const id = await submitCluster(page, {
    service: 'summarizer',
    groupId: 'ai-cluster-1',
    title: 'Topic cluster',
    confidence: 0.82,
  });

  await page.getByTestId(`proposal-reject-${id}`).click();

  await expect(page.getByTestId(`proposal-${id}`)).toHaveCount(0);
  await expect(page.getByTestId('ai-proposals-empty')).toBeVisible();
  await expect(page.getByTestId('ai-origin-count')).toHaveText('0 AI');
  await expect(page.getByTestId('ai-origin-badge')).toHaveCount(0);
  expect(await page.evaluate(() => window.__MERIDIAN_STUDIO__!.aiState().aiNodeCount)).toBe(0);
});

test('the provenance filter hides and restores all AI structure (lossless view op)', async ({
  page,
}) => {
  await boot(page);
  await openFlat(page);

  const id = await submitCluster(page, {
    service: 'summarizer',
    groupId: 'ai-cluster-1',
    title: 'Topic cluster',
    confidence: 0.82,
  });
  await page.getByTestId(`proposal-accept-${id}`).click();
  await expect(page.getByTestId(`proposal-${id}`)).toHaveCount(0);
  await waitForAiStructure(page);
  await expect(page.getByTestId('ai-origin-badge')).toHaveCount(1);

  const fullCount = await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state().nodeIds.length);

  // Evidence-only: the AI-origin node leaves the published model and its badge
  // vanishes with it. The count still reports the origin nodes in the full cut.
  await page.getByTestId('provenance-filter-toggle').click();
  await expect(page.getByTestId('provenance-filter-toggle')).toHaveAttribute('data-view', 'evidence-only');
  await settleFrames(page);
  await expect(page.getByTestId('ai-origin-badge')).toHaveCount(0);
  expect(
    await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state().nodeIds),
  ).not.toContain('ai-cluster-1');
  expect(await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state().nodeIds.length)).toBe(
    fullCount - 1,
  );

  // Toggling back restores the full model — nothing left the store.
  await page.getByTestId('provenance-filter-toggle').click();
  await expect(page.getByTestId('provenance-filter-toggle')).toHaveAttribute('data-view', 'all');
  await settleFrames(page);
  expect(
    await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state().nodeIds),
  ).toContain('ai-cluster-1');
  await expect(page.getByTestId('ai-origin-badge')).toHaveCount(1);
});

test('auto-accept is an explicit per-service opt-in', async ({ page }) => {
  await boot(page);
  await openFlat(page);

  // A proposal arrives and — with auto-accept off — sits pending (default).
  const first = await submitCluster(page, {
    service: 'clusterer',
    groupId: 'ai-cluster-1',
    title: 'First cluster',
    confidence: 0.9,
  });
  await expect(page.getByTestId(`proposal-${first}`)).toHaveAttribute('data-status', 'pending');
  await expect(page.getByTestId('auto-accept-toggle-clusterer')).not.toBeChecked();
  expect(await page.evaluate(() => window.__MERIDIAN_STUDIO__!.aiState().aiNodeCount)).toBe(0);

  // Explicit opt-in: checking the box accepts the already-pending proposal —
  // which removes it and unmounts this checkbox, so drive the change with a
  // click (not `.check()`, whose post-click checked assertion races the unmount).
  await page.getByTestId('auto-accept-toggle-clusterer').click();
  await expect(page.getByTestId(`proposal-${first}`)).toHaveCount(0);
  await waitForAiStructure(page);
  await expect(page.getByTestId('ai-origin-count')).toHaveText('1 AI');
  expect(await page.evaluate(() => window.__MERIDIAN_STUDIO__!.aiState().autoAccept.clusterer)).toEqual(
    { enabled: true },
  );

  // …and a later proposal from the same service never sits pending.
  const second = await submitCluster(page, {
    service: 'clusterer',
    groupId: 'ai-cluster-2',
    title: 'Second cluster',
    confidence: 0.9,
    fromEnd: true,
  });
  await expect(page.getByTestId(`proposal-${second}`)).toHaveCount(0);
  await page.waitForFunction(() => window.__MERIDIAN_STUDIO__!.aiState().aiNodeCount === 2, undefined, {
    timeout: 15_000,
  });
});

test('accept cancellation before the write leaves the graph untouched and makes no network request', async ({
  page,
}) => {
  const external: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith('http://127.0.0.1:') && !url.startsWith('data:') && !url.startsWith('blob:')) {
      external.push(url);
    }
  });

  await boot(page);
  await openFlat(page);

  // Submit, then accept under a signal aborted within the pre-write yield window.
  const result = await page.evaluate(async () => {
    const api = window.__MERIDIAN_STUDIO__!;
    const members = api.state().nodeIds.slice(0, 2);
    const id = api.aiSubmitProposal({
      service: 'clusterer',
      title: 'Cancelled cluster',
      proposal: {
        groups: [{ id: 'ai-cancel-1', label: 'Topic', members, rationale: '', confidence: 0.9 }],
      },
    });
    const controller = new AbortController();
    const pending = api.aiAcceptSignalled(id, controller.signal);
    controller.abort();
    const outcome = await pending;
    return { id, outcome, state: api.aiState() };
  });

  expect(result.outcome.ok).toBe(false);
  expect(result.outcome.errors).toContain('cancelled');
  // The proposal is back to pending and nothing was written.
  expect(result.state.proposals.find((p) => p.id === result.id)?.status).toBe('pending');
  expect(result.state.aiNodeCount).toBe(0);
  await expect(page.getByTestId(`proposal-${result.id}`)).toHaveAttribute('data-status', 'pending');
  await expect(page.getByTestId('ai-origin-badge')).toHaveCount(0);
  expect(
    await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state().nodeIds),
  ).not.toContain('ai-cancel-1');

  // No AI service was contacted: the entire surface is in-app and offline.
  expect(external).toEqual([]);
});
