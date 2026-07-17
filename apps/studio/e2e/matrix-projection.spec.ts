import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { boot, recordStudioBenchmarkMetrics, UI_BUDGETS } from './support.js';

const markdown = readFileSync(
  new URL('../../../fixtures/corpora/markdown/links.md', import.meta.url),
  'utf8',
);
const conversation = readFileSync(
  new URL('../../../fixtures/corpora/conversation/claude-basic.json', import.meta.url),
  'utf8',
);
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const argumentSource = `${repoRoot}fixtures/corpora/argument/pedestrian-centers.md`;
let argumentDocument = '';

test.beforeAll(() => {
  const outputDirectory = `${repoRoot}fixtures/.cut-inputs/`;
  const output = `${outputDirectory}matrix-argument.meridian.json`;
  mkdirSync(outputDirectory, { recursive: true });
  execFileSync(process.execPath, [
    `${repoRoot}apps/cli/dist/main.js`,
    'ingest',
    argumentSource,
    '--adapter',
    'argument',
    '--out',
    output,
  ]);
  argumentDocument = readFileSync(output, 'utf8');
});

async function openMatrix(page: Page, name: string, text: string, domain: string): Promise<void> {
  await page.evaluate(
    async ([sourceName, sourceText]) => {
      await window.__MERIDIAN_STUDIO__!.openText(sourceName!, sourceText!);
      await window.__MERIDIAN_STUDIO__!.switchProjection('matrix');
    },
    [name, text],
  );
  await expect(page.getByTestId('pipeline-phase')).toHaveText('ready', { timeout: 30_000 });
  await page.waitForFunction(
    () => window.__MERIDIAN_STUDIO__!.projectionId() === 'matrix',
    undefined,
    { timeout: 30_000 },
  );
  expect((await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state().adapter))?.domain).toBe(
    domain,
  );
  await expect(page.getByTestId('canvas2d-projection')).toBeVisible();
  await expect(page.locator('.meridian-projection-canvas')).toHaveAttribute(
    'data-canvas-revision',
    /matrix-\d+/,
    { timeout: 10_000 },
  );
  await expect(page.getByTestId('graph-canvas')).toHaveCount(0);
}

for (const [name, text, domain] of [
  ['matrix.md', markdown, 'markdown'],
  ['conversation.json', conversation, 'conversation'],
  ['argument.meridian.json', () => argumentDocument, 'argument'],
] as const) {
  test(`MatrixProjection mounts on the ${domain} domain: grid where meaningful, message where not`, async ({ page }) => {
    await boot(page);
    await openMatrix(page, name, typeof text === 'function' ? text() : text, domain);
    // Working means either a painted relationship grid or the explicit
    // degraded message — never a crash, a white screen, or a map fallback.
    const message = page.locator('.meridian-projection-canvas-message');
    const messageShown = await message.isVisible();
    if (messageShown) {
      await expect(message).toContainText(/no relationships/i);
    }
    expect(await page.evaluate(() => window.__MERIDIAN_STUDIO__!.projectionId())).toBe('matrix');
  });
}

test('matrix renders the 2k×2k fixture within budget and maps clicks to selection', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__MERIDIAN_STUDIO__!.openMatrixFixture(2_000));

  const start = Date.now();
  await page.evaluate(async () => {
    await window.__MERIDIAN_STUDIO__!.switchProjection('matrix');
  });
  await expect(page.locator('.meridian-projection-canvas')).toHaveAttribute(
    'data-canvas-revision',
    /matrix-\d+/,
    { timeout: 10_000 },
  );
  const elapsed = Date.now() - start;
  console.info(`[10D matrix] 2k-node switch+first-paint=${elapsed}ms`);
  expect(elapsed).toBeLessThanOrEqual(UI_BUDGETS['matrix-2k-render-ms']);
  recordStudioBenchmarkMetrics([
    { id: 'matrix-2k-render-ms', value: elapsed, unit: 'ms', sampleCount: 1 },
  ]);
  await expect(page.locator('.meridian-projection-canvas-message')).toBeHidden();

  // A click on the first diagonal cell selects that row's node.
  const canvas = page.locator('.meridian-projection-canvas');
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + 133, box.y + 9); // 1px inside cell (0, 0)
  await page.waitForFunction(
    () => window.__MERIDIAN_STUDIO__!.state().selection.nodes.length === 1,
    undefined,
    { timeout: 10_000 },
  );
  const selection = await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state().selection);
  expect(selection.nodes[0]).toMatch(/^matrix-fixture:/);
  expect(selection.anchor).toMatchObject({ kind: 'node' });
});

test('matrix degrades with a message on a cut with no relationships', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    window.__MERIDIAN_STUDIO__!.openOutlineFixture(200);
    await window.__MERIDIAN_STUDIO__!.switchProjection('matrix');
  });
  await expect(page.getByTestId('canvas2d-projection')).toBeVisible({ timeout: 30_000 });
  const message = page.locator('.meridian-projection-canvas-message');
  await expect(message).toBeVisible();
  await expect(message).toContainText(/no relationships/i);
  expect(await page.evaluate(() => window.__MERIDIAN_STUDIO__!.projectionId())).toBe('matrix');
});
