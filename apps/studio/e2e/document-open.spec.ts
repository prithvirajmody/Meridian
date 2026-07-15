import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { boot } from './support.js';

/**
 * Phase 9C exit criterion, scripted: *a real exported conversation zooms
 * topics→messages with AI topic labels in Studio.*
 *
 * The document is produced by the real pipeline — `meridian ingest` (the 9B
 * deterministic skeleton) then `meridian ai enrich` in mock mode (zero
 * network, ADR-0034's composition-root enrichment) — and opened through
 * Studio's saved-document path (`meridian:document`), which decodes a
 * `.meridian` snapshot directly instead of re-running an adapter. The AI
 * layer must be visible at the topic level, carry AI provenance recognized
 * by the 8F trust surface, and remain globally filterable (ADR-0031).
 */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const cli = `${repoRoot}apps/cli/dist/main.js`;

interface WireNode {
  id: string;
  kind: string;
  label: string;
  provenance: { origin: string };
}

let enrichedText: string;
let topicIds: string[] = [];
let messageIds: string[] = [];

test.beforeAll(() => {
  const dir = `${repoRoot}fixtures/.cut-inputs/`;
  mkdirSync(dir, { recursive: true });
  const skeleton = `${dir}e2e-conv-two-topics.meridian.json`;
  const enriched = `${dir}e2e-conv-two-topics.enriched.meridian.json`;
  execFileSync(process.execPath, [
    cli, 'ingest', `${repoRoot}fixtures/corpora/conversation/claude-two-topics.json`,
    '--adapter', 'conversation', '--out', skeleton,
  ]);
  execFileSync(process.execPath, [cli, 'ai', 'enrich', skeleton, '--out', enriched]);
  enrichedText = readFileSync(enriched, 'utf8');
  const doc = JSON.parse(enrichedText) as { graphs: { nodes: WireNode[] }[] };
  const nodes = doc.graphs.flatMap((g) => g.nodes);
  topicIds = nodes.filter((n) => n.kind === 'conv:topic').map((n) => n.id);
  messageIds = nodes.filter((n) => n.kind === 'conv:message').map((n) => n.id);
});

test('an enriched conversation opens as a saved document and zooms topics→messages', async ({ page }) => {
  await boot(page);
  await page.evaluate(
    ([name, text]) => window.__MERIDIAN_STUDIO__!.openText(name!, text!),
    ['two-topics.meridian.json', enrichedText],
  );
  await expect(page.getByTestId('pipeline-phase')).toHaveText('ready', { timeout: 30_000 });

  // Opened through the document path, not an adapter re-ingest.
  const adapter = await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state().adapter);
  expect(adapter?.plugin).toBe('meridian:document');
  expect(adapter?.domain).toBe('conversation');

  // The 8F trust surface recognizes the document's AI-origin structure.
  const ai = await page.evaluate(() => window.__MERIDIAN_STUDIO__!.aiState());
  expect(ai.aiNodeCount).toBeGreaterThan(0);
  for (const id of topicIds) expect(ai.aiNodeIds).toContain(id);

  // Topic level: every AI topic (with its AI-generated label) is in the cut.
  await page.evaluate(() => window.__MERIDIAN_STUDIO__!.navZoomTo(0.375));
  await page.waitForFunction(
    (ids) => {
      const visible = new Set(window.__MERIDIAN_STUDIO__!.state().nodeIds);
      return ids!.every((id) => visible.has(id));
    },
    topicIds,
    { timeout: 30_000 },
  );
  expect(topicIds.length).toBeGreaterThanOrEqual(2);

  // Finest level: the topics' detail chain bottoms out in the messages.
  await page.evaluate(() => window.__MERIDIAN_STUDIO__!.navZoomTo(1));
  await page.waitForFunction(
    (ids) => {
      const visible = new Set(window.__MERIDIAN_STUDIO__!.state().nodeIds);
      return ids!.every((id) => visible.has(id));
    },
    messageIds,
    { timeout: 30_000 },
  );
  expect(messageIds).toHaveLength(12);

  // ADR-0031: one toggle shows the graph as evidence-only — AI structure is
  // globally filterable and losslessly restored.
  await page.getByTestId('provenance-filter-toggle').click();
  await page.waitForFunction(
    (ids) => {
      const visible = new Set(window.__MERIDIAN_STUDIO__!.state().nodeIds);
      return ids!.every((id) => !visible.has(id));
    },
    topicIds,
    { timeout: 30_000 },
  );
  await page.getByTestId('provenance-filter-toggle').click();
  await page.waitForFunction(
    () => window.__MERIDIAN_STUDIO__!.aiState().aiNodeCount > 0,
    undefined,
    { timeout: 30_000 },
  );
});

test('an invalid document is a clean pipeline failure, not a crash', async ({ page }) => {
  await boot(page);
  await page.evaluate(() =>
    window.__MERIDIAN_STUDIO__!.openText('broken.meridian.json', '{"formatVersion":1,"graphs":"nope"}'),
  );
  await expect(page.getByTestId('pipeline-phase')).toHaveText('error', { timeout: 30_000 });
});
