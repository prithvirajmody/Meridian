/**
 * Mid-transition visual baselines (roadmap Phase 6 §12 "UI verification"):
 * the app boots with the injected deterministic clock (`?clock=manual`,
 * ADR-0023 "time is injected"), a threshold-crossing zoom is frozen mid-flight
 * at exact clock times, and the frame is screenshot against a golden. The
 * store-mutation-mid-transition replan is also driven here, where timing is
 * deterministic.
 */
import { expect, test, type Page } from '@playwright/test';
import { boot, openCorpus, settleFrames, telemetry } from './support.js';

const CENTER = { x: 640, y: 400 } as const;

async function startZoomTransition(page: Page, factor: number): Promise<void> {
  await page.evaluate(
    ({ factor: f, x, y }) => window.__MERIDIAN_STUDIO__!.navZoomBy(f, x, y),
    { factor, x: CENTER.x, y: CENTER.y },
  );
  await page.waitForFunction(() => window.__MERIDIAN_STUDIO__!.transitionActive(), undefined, {
    timeout: 15_000,
  });
}

test.describe('mid-transition visual baselines (deterministic clock)', () => {
  for (const corpus of ['basic.md', 'pathological-nesting.md'] as const) {
    test(`${corpus}: frozen mid-flight frames match goldens`, async ({ page }) => {
      test.setTimeout(90_000);
      await boot(page, '?e2e=1&clock=manual');
      expect(await page.evaluate(() => window.__MERIDIAN_STUDIO__!.clockIsManual())).toBe(true);
      await openCorpus(page, corpus);

      await startZoomTransition(page, 60); // one gesture, saturating descent
      const name = corpus.replace('.md', '');

      // 25% of the flight: spawn geometry visible, entering nodes translucent.
      await page.evaluate(() => window.__MERIDIAN_STUDIO__!.clockAdvance(60));
      await settleFrames(page);
      await expect(page).toHaveScreenshot(`${name}-transition-t25.png`);

      // 62.5%: past the midpoint of the shared easing.
      await page.evaluate(() => window.__MERIDIAN_STUDIO__!.clockAdvance(90));
      await settleFrames(page);
      await expect(page).toHaveScreenshot(`${name}-transition-t62.png`);

      // Settled: the incoming cut, fully opaque.
      await page.evaluate(() => window.__MERIDIAN_STUDIO__!.clockAdvance(500));
      await settleFrames(page);
      await expect(page).toHaveScreenshot(`${name}-transition-settled.png`);

      const records = await telemetry(page);
      expect(records.at(-1)!.settledAtMs).not.toBeNull();
      expect(records.at(-1)!.maxDriftPx).toBeLessThan(8);
    });
  }

  test('a store mutation mid-transition forces a replan from the interpolated frame', async ({ page }) => {
    await boot(page, '?e2e=1&clock=manual');
    await openCorpus(page, 'basic.md');
    await startZoomTransition(page, 60);
    await page.evaluate(() => window.__MERIDIAN_STUDIO__!.clockAdvance(80)); // mid-flight

    const applied = await page.evaluate(() => {
      const api = window.__MERIDIAN_STUDIO__!;
      const node = api.state().nodeIds[0]!;
      return api.mutateNodeLabel(node, 'Mutated mid-transition');
    });
    expect(applied).toBe(true);

    await page.waitForFunction(() => {
      const records = window.__MERIDIAN_STUDIO__!.transitionTelemetry();
      return records.at(-1)?.trigger === 'mutation';
    });
    const records = await telemetry(page);
    expect(records.at(-2)!.superseded).toBe(true); // the zoom flight was replaced,
    expect(records.at(-1)!.replannedFromFlight).toBe(true); // not queued behind

    await page.evaluate(() => window.__MERIDIAN_STUDIO__!.clockAdvance(1000));
    await page.waitForFunction(() => !window.__MERIDIAN_STUDIO__!.transitionActive());
    const search = await page.evaluate(() => window.__MERIDIAN_STUDIO__!.navSearch('mutated'));
    expect(search.length).toBeGreaterThan(0);
  });

  test('retarget-not-queue is drivable on the frozen clock', async ({ page }) => {
    await boot(page, '?e2e=1&clock=manual');
    await openCorpus(page, 'basic.md');
    await startZoomTransition(page, 60);
    await page.evaluate(() => window.__MERIDIAN_STUDIO__!.clockAdvance(80));
    // A reverse gesture mid-flight replans from the interpolated state.
    await page.evaluate(
      ({ x, y }) => window.__MERIDIAN_STUDIO__!.navZoomBy(1 / 60, x, y),
      CENTER,
    );
    await page.waitForFunction(
      () => window.__MERIDIAN_STUDIO__!.transitionTelemetry().length >= 2,
    );
    const records = await telemetry(page);
    expect(records[0]!.superseded).toBe(true);
    expect(records[0]!.settledAtMs).toBeNull();
    expect(records.at(-1)!.replannedFromFlight).toBe(true);
    await page.evaluate(() => window.__MERIDIAN_STUDIO__!.clockAdvance(1000));
    await page.waitForFunction(() => !window.__MERIDIAN_STUDIO__!.transitionActive());
  });
});
