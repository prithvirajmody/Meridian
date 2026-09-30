import { expect, test } from '@playwright/test';
import {
  boot,
  percentile95,
  perfBudget,
  recordStudioBenchmarkMetrics,
  UI_BUDGETS,
} from './support.js';

const enabled = process.env.MERIDIAN_PHASE11_BENCH === '1';

test('Phase 11 edit-to-pixel p95 emits the dashboard input', async ({ page }) => {
  test.skip(!enabled, 'run by the pinned Phase 11 benchmark job');
  test.setTimeout(240_000);
  await boot(page);

  const sectionCount = Number(process.env.MERIDIAN_PHASE11_SECTIONS ?? 25_000);
  await page.evaluate(async (count) => {
    const text = Array.from(
      { length: count },
      (_, index) => `# Working section ${index}\n\nWorking paragraph ${index}.`,
    ).join('\n\n');
    await window.__MERIDIAN_STUDIO__!.openText('phase11-working-set.md', text);
  }, sectionCount);
  await page.waitForFunction(
    () => (window.__MERIDIAN_STUDIO__!.state().rendererStats?.frameCount ?? 0) > 0,
    undefined,
    { timeout: 120_000 },
  );

  const node = await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state().nodeIds[0]);
  expect(node).toBeDefined();
  const samples: number[] = [];
  const modelSamples: number[] = [];
  const sampleCount = Number(process.env.MERIDIAN_PHASE11_EDIT_SAMPLES ?? 24);
  for (let index = 0; index < sampleCount; index++) {
    const before = await page.evaluate(() => window.__MERIDIAN_STUDIO__!.incrementalTelemetry().length);
    const applied = await page.evaluate(
      ({ id, iteration }) => window.__MERIDIAN_STUDIO__!.mutateNodeLabel(id!, `Pixel edit ${iteration}`),
      { id: node, iteration: index },
    );
    expect(applied).toBe(true);
    await page.waitForFunction(
      (prior) => {
        const telemetry = window.__MERIDIAN_STUDIO__!.incrementalTelemetry();
        return telemetry.length > prior && telemetry.at(-1)?.editToPixelMs !== null;
      },
      before,
      { timeout: 15_000 },
    );
    const latest = await page.evaluate(() => {
      const record = window.__MERIDIAN_STUDIO__!.incrementalTelemetry().at(-1)!;
      return { pixel: record.editToPixelMs!, model: record.editToModelMs };
    });
    samples.push(latest.pixel);
    modelSamples.push(latest.model);
  }

  const p95 = percentile95(samples);
  console.info(
    `[11F edit→pixel] storedFixtureSections=${sectionCount} samples=${samples.length} ` +
      `p95=${p95.toFixed(1)}ms min=${Math.min(...samples).toFixed(1)}ms max=${Math.max(...samples).toFixed(1)}ms`,
  );
  console.info(
    `[11F edit→model] p95=${percentile95(modelSamples).toFixed(1)}ms ` +
      `min=${Math.min(...modelSamples).toFixed(1)}ms max=${Math.max(...modelSamples).toFixed(1)}ms`,
  );
  perfBudget('edit-to-pixel-p95-ms', p95, () =>
    expect(p95).toBeLessThanOrEqual(UI_BUDGETS['edit-to-pixel-p95-ms']),
  );
  recordStudioBenchmarkMetrics([
    {
      id: 'edit-to-pixel-p95-ms',
      value: p95,
      unit: 'ms',
      sampleCount: samples.length,
    },
  ]);
});
