/**
 * Phase 10F gate: the 4×3 mode-switch matrix (map/outline/matrix/timeline ×
 * markdown/conversation/argument), ADR-0036 survival (selection + focus
 * always; per-projection view state; focus visibility), the <200ms switch
 * budget, switch-mid-transition, and mount-failure fallback to map.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { boot, percentile95, recordStudioBenchmarkMetrics, settleFrames, UI_BUDGETS } from './support.js';

const markdown = readFileSync(
  new URL('../../../fixtures/corpora/markdown/basic.md', import.meta.url),
  'utf8',
);
const conversation = readFileSync(
  new URL('../../../fixtures/corpora/conversation/claude-basic.json', import.meta.url),
  'utf8',
);
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
let argumentDocument = '';

test.beforeAll(() => {
  const outputDirectory = `${repoRoot}fixtures/.cut-inputs/`;
  const output = `${outputDirectory}mode-switch-argument.meridian.json`;
  mkdirSync(outputDirectory, { recursive: true });
  execFileSync(process.execPath, [
    `${repoRoot}apps/cli/dist/main.js`,
    'ingest',
    `${repoRoot}fixtures/corpora/argument/pedestrian-centers.md`,
    '--adapter',
    'argument',
    '--out',
    output,
  ]);
  argumentDocument = readFileSync(output, 'utf8');
});

const PROJECTIONS = ['outline', 'matrix', 'timeline', 'map'] as const;

async function open(page: Page, name: string, text: string): Promise<void> {
  await page.evaluate(
    async ([sourceName, sourceText]) => {
      await window.__MERIDIAN_STUDIO__!.openText(sourceName!, sourceText!);
    },
    [name, text],
  );
  await expect(page.getByTestId('pipeline-phase')).toHaveText('ready', { timeout: 30_000 });
}

async function switchTimed(page: Page, id: string): Promise<number> {
  return page.evaluate(async (target) => {
    const start = performance.now();
    await window.__MERIDIAN_STUDIO__!.switchProjection(target);
    return performance.now() - start;
  }, id);
}

async function selectFirstOutlineRow(page: Page): Promise<string> {
  await switchTimed(page, 'outline');
  const tree = page.locator('[role="tree"]');
  await tree.focus();
  await tree.press('Home');
  await tree.press('Enter');
  await page.waitForFunction(
    () => window.__MERIDIAN_STUDIO__!.state().selection.nodes.length === 1,
    undefined,
    { timeout: 10_000 },
  );
  return (await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state().selection.nodes[0]))!;
}

for (const [name, text, domain] of [
  ['mode-switch.md', markdown, 'markdown'],
  ['conversation.json', conversation, 'conversation'],
  ['argument.meridian.json', () => argumentDocument, 'argument'],
] as const) {
  test(`4×3 matrix on ${domain}: every mode mounts, selection survives, visual baselines hold`, async ({ page }) => {
    test.setTimeout(120_000);
    await boot(page);
    await open(page, name, typeof text === 'function' ? text() : text);

    const selected = await selectFirstOutlineRow(page);
    const durations: number[] = [];

    for (const projection of [...PROJECTIONS, 'outline'] as const) {
      durations.push(await switchTimed(page, projection));
      await page.waitForFunction(
        (expected) => window.__MERIDIAN_STUDIO__!.projectionId() === expected,
        projection,
        { timeout: 15_000 },
      );

      // ADR-0036: identity survives every switch, whatever the medium.
      const state = await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state());
      expect(state.selection.nodes).toEqual([selected]);
      expect(state.selection.anchor).toMatchObject({ kind: 'node', id: selected });

      if (projection === 'map') {
        await expect(page.getByTestId('graph-canvas')).toBeVisible();
      } else if (projection === 'outline') {
        await expect(page.locator('[role="tree"]')).toBeVisible();
        // Focus-visibility rule: the selection anchor's row is in the live window.
        await expect(
          page.locator(`[role="treeitem"][data-outline-row-key="${selected}"]`),
        ).toHaveAttribute('aria-selected', 'true');
      } else {
        await expect(page.getByTestId('canvas2d-projection')).toBeVisible();
        await expect(page.locator('.meridian-projection-canvas')).toHaveAttribute(
          'data-canvas-revision',
          new RegExp(`${projection}-\\d+`),
        );
      }
      await expect(page.getByTestId('mode-switcher')).toBeVisible();
      await expect(page.getByTestId(`mode-${projection}`)).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await settleFrames(page, 3);
      await expect(page.getByTestId('canvas-island')).toHaveScreenshot(
        `mode-${domain}-${projection}.png`,
      );
    }

    const p95 = percentile95(durations);
    console.info(
      `[10F switch] domain=${domain} switches=${durations.length} p95=${p95.toFixed(1)}ms max=${Math.max(...durations).toFixed(1)}ms`,
    );
    expect(p95).toBeLessThanOrEqual(UI_BUDGETS['projection-switch-ms']);
    recordStudioBenchmarkMetrics([
      { id: 'projection-switch-ms', value: p95, unit: 'ms', sampleCount: durations.length },
    ]);
  });
}

test('a switch issued mid-transition completes the semantic intent and lands cleanly', async ({ page }) => {
  await boot(page, '?e2e=1&clock=manual');
  expect(await page.evaluate(() => window.__MERIDIAN_STUDIO__!.clockIsManual())).toBe(true);
  await open(page, 'mode-switch.md', markdown);

  await page.evaluate(() => window.__MERIDIAN_STUDIO__!.navZoomBy(60, 640, 400));
  await page.waitForFunction(() => window.__MERIDIAN_STUDIO__!.transitionActive(), undefined, {
    timeout: 15_000,
  });
  // Freeze mid-flight, then switch: the semantic target must complete and the
  // remaining visual interpolation must be cancelled (ADR-0036 step 3).
  await page.evaluate(() => window.__MERIDIAN_STUDIO__!.clockAdvance(80));
  await page.evaluate(async () => {
    await window.__MERIDIAN_STUDIO__!.switchProjection('outline');
  });
  await expect(page.locator('[role="tree"]')).toBeVisible();
  expect(await page.evaluate(() => window.__MERIDIAN_STUDIO__!.transitionActive())).toBe(false);
  expect(await page.evaluate(() => window.__MERIDIAN_STUDIO__!.projectionId())).toBe('outline');

  // Round-trip back to the map: still healthy, no stale animation resumes.
  await page.evaluate(async () => {
    await window.__MERIDIAN_STUDIO__!.switchProjection('map');
  });
  await expect(page.getByTestId('graph-canvas')).toBeVisible();
  expect(await page.evaluate(() => window.__MERIDIAN_STUDIO__!.transitionActive())).toBe(false);
});

test('a projection that throws on mount is contained and the host falls back to map', async ({ page }) => {
  await boot(page);
  await open(page, 'mode-switch.md', markdown);
  await page.evaluate(async () => {
    window.__MERIDIAN_STUDIO__!.registerBombProjection();
    await window.__MERIDIAN_STUDIO__!.switchProjection('bomb');
  });
  await page.waitForFunction(() => window.__MERIDIAN_STUDIO__!.projectionId() === 'map', undefined, {
    timeout: 15_000,
  });
  await expect(page.getByTestId('graph-canvas')).toBeVisible();
  const diagnostics = await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state().diagnostics);
  expect(diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ source: 'projection', code: 'projection-mount-failed' }),
    ]),
  );
});

test('per-projection view state survives a round trip (outline scroll restored)', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    window.__MERIDIAN_STUDIO__!.openOutlineFixture(2_000);
    await window.__MERIDIAN_STUDIO__!.switchProjection('outline');
  });
  await expect(page.locator('[role="tree"]')).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('.meridian-outline-virtual-list')!.scrollTop = 4_096;
  });
  await settleFrames(page, 2);

  await page.evaluate(async () => {
    await window.__MERIDIAN_STUDIO__!.switchProjection('matrix');
  });
  await expect(page.getByTestId('canvas2d-projection')).toBeVisible();
  await page.evaluate(async () => {
    await window.__MERIDIAN_STUDIO__!.switchProjection('outline');
  });
  await expect(page.locator('[role="tree"]')).toBeVisible();
  await settleFrames(page, 2);
  const scrollTop = await page.evaluate(
    () => document.querySelector<HTMLElement>('.meridian-outline-virtual-list')!.scrollTop,
  );
  expect(scrollTop).toBe(4_096);
});
