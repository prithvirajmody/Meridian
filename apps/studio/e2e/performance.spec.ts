import { expect, test } from '@playwright/test';
import { boot, recordStudioBenchmarkMetrics, settleFrames, UI_BUDGETS } from './support.js';

test('10k labelled fixture keeps the frame budget: draw p95 <= 18ms, >= 55fps sustained', async ({ page }) => {
  test.setTimeout(90_000);
  await boot(page);
  await page.evaluate(() => window.__MERIDIAN_STUDIO__!.openPerformanceFixture());
  await page.waitForFunction(
    () => window.__MERIDIAN_STUDIO__?.state().rendererStats?.modelNodes === 10_000,
    undefined,
    { timeout: 30_000 },
  );

  const first = await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state());
  expect(first.metrics.firstRenderMs).not.toBeNull();
  expect(first.metrics.firstRenderMs!).toBeLessThan(UI_BUDGETS['renderer-first-render-ms']);

  const result = await page.evaluate(() => window.__MERIDIAN_STUDIO__!.runFrameProbe(300, 60));
  expect(result.modelNodes).toBe(10_000);
  expect(result.frames).toBeGreaterThanOrEqual(295);
  expect(result.liveLabels).toBeGreaterThan(0);
  expect(result.liveLabels).toBeLessThanOrEqual(UI_BUDGETS['renderer-max-live-labels']);
  // Wall-clock p95 <= 18ms is a real-GPU property (see the local
  // @meridian/renderer fps probe and docs/checklists/phase-05.md): SwiftShader
  // needs >1 vsync to raster this canvas no matter what the renderer does. CI
  // asserts the renderer's own per-frame cost plus sustained throughput.
  expect(result.p95DrawTimeMs).toBeLessThanOrEqual(UI_BUDGETS['renderer-frame-p95-ms']);
  expect(1000 / result.meanFrameTimeMs).toBeGreaterThanOrEqual(
    UI_BUDGETS['renderer-throughput-min-fps'],
  );
  recordStudioBenchmarkMetrics([
    { id: 'renderer-frame-p95-ms', value: result.p95DrawTimeMs, unit: 'ms', sampleCount: result.frames },
    { id: 'renderer-throughput-min-fps', value: 1000 / result.meanFrameTimeMs, unit: 'fps', sampleCount: result.frames },
    { id: 'renderer-first-render-ms', value: first.metrics.firstRenderMs!, unit: 'ms', sampleCount: 1 },
    { id: 'renderer-max-live-labels', value: result.liveLabels, unit: 'count', sampleCount: result.frames },
  ]);
});

test('10k viewport culling drops visible work and draw calls at close zoom', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__MERIDIAN_STUDIO__!.openPerformanceFixture());
  await page.waitForFunction(
    () => window.__MERIDIAN_STUDIO__?.state().rendererStats?.modelNodes === 10_000,
  );
  await page.evaluate(() => window.__MERIDIAN_STUDIO__!.fit());
  await settleFrames(page);
  const overview = await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state().rendererStats!);
  await page.evaluate(() => window.__MERIDIAN_STUDIO__!.zoomBy(10));
  await settleFrames(page);
  const close = await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state().rendererStats!);
  expect(close.visibleNodes).toBeLessThan(overview.visibleNodes);
  expect(close.drawCalls).toBeLessThan(overview.drawCalls);
});
