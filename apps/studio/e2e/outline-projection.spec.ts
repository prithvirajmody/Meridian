import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { OUTLINE_OVERSCAN, OUTLINE_ROW_HEIGHT } from '@meridian/renderer';
import { boot, percentile95, settleFrames, UI_BUDGETS } from './support.js';

const markdown = readFileSync(
  new URL('../../../fixtures/corpora/markdown/basic.md', import.meta.url),
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
  const output = `${outputDirectory}outline-argument.meridian.json`;
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

async function openOutline(
  page: Page,
  name: string,
  text: string,
  domain: string,
): Promise<void> {
  await page.evaluate(
    async ([sourceName, sourceText]) => {
      await window.__MERIDIAN_STUDIO__!.openText(sourceName!, sourceText!);
      await window.__MERIDIAN_STUDIO__!.switchProjection('outline');
    },
    [name, text],
  );
  await expect(page.getByTestId('pipeline-phase')).toHaveText('ready', { timeout: 30_000 });
  await page.waitForFunction(
    () => window.__MERIDIAN_STUDIO__!.projectionId() === 'outline',
    undefined,
    { timeout: 30_000 },
  );
  expect((await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state().adapter))?.domain).toBe(
    domain,
  );
  await expect(page.getByTestId('outline-projection')).toBeVisible();
  await expect(page.locator('[role="tree"]')).toBeVisible();
  await expect(page.locator('[role="treeitem"]').first()).toBeVisible();
  await expect(page.getByTestId('graph-canvas')).toHaveCount(0);
}

for (const [name, text, domain] of [
  ['outline.md', markdown, 'markdown'],
  ['conversation.json', conversation, 'conversation'],
  ['argument.meridian.json', () => argumentDocument, 'argument'],
] as const) {
  test(`OutlineProjection renders the ${domain} domain through the projection host`, async ({ page }) => {
    await boot(page);
    await openOutline(page, name, typeof text === 'function' ? text() : text, domain);
    const ariaLevels = await page.locator('[role="treeitem"]').evaluateAll((rows) =>
      rows.map((row) => Number(row.getAttribute('aria-level'))),
    );
    expect(ariaLevels.length).toBeGreaterThan(0);
    expect(ariaLevels.every((level) => Number.isInteger(level) && level >= 1)).toBe(true);
  });
}

test('outline keyboard navigation selects the active row and Studio reads it back', async ({ page }) => {
  await boot(page);
  await openOutline(page, 'outline.md', markdown, 'markdown');

  const tree = page.locator('[role="tree"]');
  await tree.focus();
  await tree.press('End');
  await settleFrames(page, 2);
  const active = page.locator('[role="treeitem"][data-outline-active="true"]');
  await expect(active).toHaveCount(1);
  const nodeId = await active.getAttribute('data-outline-row-key');
  expect(nodeId).not.toBeNull();

  await tree.press('Enter');
  await page.waitForFunction(
    (expected) => window.__MERIDIAN_STUDIO__!.state().panel?.id === expected,
    nodeId,
    { timeout: 10_000 },
  );
  expect((await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state().panel))?.id).toBe(nodeId);
  await expect(active).toHaveAttribute('aria-selected', 'true');
});

test('100k outline rows keep a bounded DOM window while sustained scrolling stays responsive', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    window.__MERIDIAN_STUDIO__!.openOutlineFixture(100_000);
    await window.__MERIDIAN_STUDIO__!.switchProjection('outline');
  });
  await expect(page.getByTestId('outline-projection')).toBeVisible({ timeout: 30_000 });

  const result = await page.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>('.meridian-outline-virtual-list')!;
    const intervals: number[] = [];
    let previous: number | null = null;
    const frames = 330;
    for (let index = 0; index < frames; index++) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame((timestamp) => {
          if (previous !== null && index >= 30) intervals.push(timestamp - previous);
          previous = timestamp;
          const progress = index / (frames - 1);
          scroller.scrollTop = progress * Math.max(0, scroller.scrollHeight - scroller.clientHeight);
          resolve();
        });
      });
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const rowCount = scroller.querySelectorAll('[role="treeitem"]').length;
    const lastIndex = Math.max(
      -1,
      ...[...scroller.querySelectorAll<HTMLElement>('[data-outline-row-index]')].map((row) =>
        Number(row.dataset.outlineRowIndex),
      ),
    );
    return {
      intervals,
      rowCount,
      lastIndex,
      viewportHeight: scroller.clientHeight,
    };
  });

  const p95 = percentile95(result.intervals);
  const mean =
    result.intervals.reduce((sum, value) => sum + value, 0) /
    Math.max(1, result.intervals.length);
  const meanFps = 1000 / mean;
  console.info(
    `[10C outline] rows=100000 cadenceP95Ms=${p95.toFixed(2)} meanFps=${meanFps.toFixed(1)} liveRows=${result.rowCount}`,
  );
  expect(meanFps).toBeGreaterThanOrEqual(UI_BUDGETS['outline-scroll-min-fps']);
  expect(result.rowCount).toBeLessThanOrEqual(
    Math.ceil(result.viewportHeight / OUTLINE_ROW_HEIGHT) + 1 + OUTLINE_OVERSCAN * 2,
  );
  expect(result.lastIndex).toBe(99_999);
});
