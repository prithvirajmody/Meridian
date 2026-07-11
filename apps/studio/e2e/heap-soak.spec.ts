import { expect, test } from '@playwright/test';
import { boot, UI_BUDGETS } from './support.js';

const SOAK_MS = Number(
  process.env.MERIDIAN_HEAP_SOAK_MS ?? UI_BUDGETS['studio-heap-soak-ms'],
);

test('5-minute pan/zoom heap soak remains stable', async ({ page }) => {
  test.setTimeout(SOAK_MS + 90_000);
  await boot(page);
  await page.evaluate(() => window.__MERIDIAN_STUDIO__!.openPerformanceFixture());
  await page.waitForFunction(
    () => window.__MERIDIAN_STUDIO__?.state().rendererStats?.modelNodes === 10_000,
  );

  const cdp = await page.context().newCDPSession(page);
  const heapSamples: number[] = [];
  const domSamples: Array<{ nodes: number; listeners: number }> = [];
  const sample = async (): Promise<void> => {
    await cdp.send('HeapProfiler.collectGarbage');
    const heap = await cdp.send('Runtime.getHeapUsage');
    const dom = await cdp.send('Memory.getDOMCounters');
    heapSamples.push(heap.usedSize);
    domSamples.push({ nodes: dom.nodes, listeners: dom.jsEventListeners });
  };

  await sample();
  const started = Date.now();
  let nextSample = started + 30_000;
  while (Date.now() - started < SOAK_MS) {
    await page.evaluate(() => window.__MERIDIAN_STUDIO__!.runFrameProbe(120, 0));
    if (Date.now() >= nextSample) {
      await sample();
      nextSample += 30_000;
    }
  }
  await sample();

  const retainedGrowth = heapSamples.at(-1)! - heapSamples[0]!;
  expect(retainedGrowth).toBeLessThanOrEqual(
    UI_BUDGETS['studio-heap-retained-growth-bytes'],
  );
  expect(domSamples.at(-1)!.nodes).toBeLessThanOrEqual(domSamples[0]!.nodes + 50);
  expect(domSamples.at(-1)!.listeners).toBeLessThanOrEqual(domSamples[0]!.listeners + 20);
});
