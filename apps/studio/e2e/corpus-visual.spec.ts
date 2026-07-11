import { expect, test } from '@playwright/test';
import { boot, CORPORA, openCorpus, settleFrames, UI_BUDGETS } from './support.js';

test.describe('corpus boot and deterministic visual baselines', () => {
  for (const corpus of CORPORA) {
    test(`${corpus} renders at overview, mid, and close geometric scales`, async ({ page }) => {
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await boot(page);
      await openCorpus(page, corpus);

      const state = await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state());
      expect(state.adapter).toMatchObject({ domain: 'markdown', plugin: '@meridian/adapter-markdown' });
      expect(state.modelRevision).toMatch(/^rm-/);
      if (corpus === 'empty.md') expect(state.nodeIds).toHaveLength(0);
      expect(state.metrics.firstRenderMs).not.toBeNull();
      expect(state.metrics.firstRenderMs!).toBeLessThan(UI_BUDGETS['renderer-first-render-ms']);

      for (const [name, factor] of [
        ['overview', 1],
        ['mid', 2],
        ['close', 4],
      ] as const) {
        await page.evaluate(
          ({ zoom }) => {
            window.__MERIDIAN_STUDIO__!.fit();
            if (zoom !== 1) window.__MERIDIAN_STUDIO__!.zoomBy(zoom);
          },
          { zoom: factor },
        );
        await settleFrames(page);
        await expect(page).toHaveScreenshot(`${corpus.replace('.md', '')}-${name}.png`);
      }

      expect(pageErrors).toEqual([]);
    });
  }

  test('pinned Unicode corpus labels render CJK, RTL Arabic, emoji/ZWJ, and NFC text without tofu', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => window.__MERIDIAN_STUDIO__!.openUnicodeFixture());
    await page.waitForFunction(
      () => (window.__MERIDIAN_STUDIO__?.state().rendererStats?.fallbackLabelCount ?? 0) >= 3,
    );
    const state = await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state());
    expect(state.rendererStats?.fallbackLabelCount).toBeGreaterThanOrEqual(3);
    expect(state.rendererStats?.bitmapLabelCount).toBeGreaterThanOrEqual(1);
    await expect(page).toHaveScreenshot('unicode-fallback.png');
  });
});
