import { expect, test } from '@playwright/test';
import { boot, openCorpus, percentile95, settleFrames, UI_BUDGETS } from './support.js';

test('hover promotes a label and click populates attrs/provenance in <16ms p95', async ({ page }) => {
  await boot(page);
  await openCorpus(page, 'links.md');
  // 6D boots at the controller's semantic camera, not auto-fit; frame the
  // whole graph geometrically so the probed node is on-screen (cut unchanged).
  await page.evaluate(() => window.__MERIDIAN_STUDIO__!.fit());
  await settleFrames(page);
  const canvas = page.getByTestId('graph-canvas');
  const nodeId = await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state().nodeIds[0]!);
  const point = await page.evaluate((id) => window.__MERIDIAN_STUDIO__!.screenPointForNode(id), nodeId);
  expect(point).not.toBeNull();

  // The worker-built spatial index may publish just after first paint. Repeated
  // moves are real pointer input and keep the test independent of private state.
  for (let attempt = 0; attempt < 20; attempt++) {
    await canvas.hover({ position: { x: point!.x + (attempt % 2) * 0.1, y: point!.y } });
    const hovered = await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state().hover);
    if (hovered?.element.kind === 'node') break;
    await page.waitForTimeout(20);
  }
  await expect.poll(async () => {
    const hover = await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state().hover);
    return hover?.element.kind === 'node' ? hover.element.nodeId : null;
  }).toBe(nodeId);
  await expect(page.getByTestId('hover-readout')).toContainText(nodeId);

  const latencies: number[] = [];
  let previousStarted = '';
  for (let sample = 0; sample < 20; sample++) {
    await canvas.click({ position: point! });
    await expect(page.getByTestId('selection-panel')).toHaveAttribute('data-selected-id', nodeId);
    await expect.poll(async () => {
      const value = await page.getByTestId('selection-panel').getAttribute('data-selection-started-at');
      return value !== null && value !== previousStarted ? value : null;
    }).not.toBeNull();
    previousStarted = (await page.getByTestId('selection-panel').getAttribute('data-selection-started-at'))!;
    await settleFrames(page, 1);
    const latency = await page.evaluate(
      () => window.__MERIDIAN_STUDIO__!.state().metrics.interactionLatencyMs,
    );
    expect(latency).not.toBeNull();
    latencies.push(latency!);
  }

  await expect(page.getByTestId('selected-attrs')).toBeVisible();
  await expect(page.getByTestId('selected-provenance')).toContainText('source');
  expect(percentile95(latencies)).toBeLessThan(UI_BUDGETS['renderer-interaction-p95-ms']);
});

test('HUD is absent normally and exposes FPS/heap only behind debug=1', async ({ page }) => {
  await boot(page);
  await expect(page.getByTestId('debug-hud')).toHaveCount(0);
  await boot(page, '?e2e=1&debug=1');
  await page.evaluate(() => window.__MERIDIAN_STUDIO__!.openUnicodeFixture());
  await expect(page.getByTestId('debug-hud')).toBeVisible();
  await expect(page.getByTestId('debug-hud')).toContainText('frame');
});
