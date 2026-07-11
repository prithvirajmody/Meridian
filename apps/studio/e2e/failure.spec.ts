import { expect, test } from '@playwright/test';
import { boot, settleFrames } from './support.js';

test('real WEBGL_lose_context restores the same RenderModel without a pipeline rerun', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__MERIDIAN_STUDIO__!.openUnicodeFixture());
  await page.waitForFunction(() => (window.__MERIDIAN_STUDIO__?.state().rendererStats?.frameCount ?? 0) > 0);
  const before = await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state());
  const supported = await page.evaluate(() => window.__MERIDIAN_STUDIO__!.loseContext());
  test.skip(!supported, 'SwiftShader did not expose WEBGL_lose_context');
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__MERIDIAN_STUDIO__!.restoreContext())).toBe(true);
  await page.waitForFunction(
    (frame) => {
      const stats = window.__MERIDIAN_STUDIO__?.state().rendererStats;
      return stats !== null && stats !== undefined && stats.contextLosses >= 1 && stats.frameCount > frame;
    },
    before.rendererStats!.frameCount,
  );
  const after = await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state());
  expect(after.modelRevision).toBe(before.modelRevision);
  expect(after.phase).toBe('ready');
});

test('zero-node and hostile-layout models render without a white screen', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__MERIDIAN_STUDIO__!.openEmptyFixture());
  await page.waitForFunction(() => window.__MERIDIAN_STUDIO__?.state().rendererStats?.modelNodes === 0);
  expect((await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state())).phase).toBe('ready');

  await page.evaluate(() => window.__MERIDIAN_STUDIO__!.openHostileLayoutFixture());
  await page.waitForFunction(() => window.__MERIDIAN_STUDIO__?.state().rendererStats?.modelNodes === 1);
  await settleFrames(page);
  const hostile = await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state());
  expect(hostile.diagnostics).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'non-finite-position', elementId: 'hostile:node' })]),
  );
  expect(hostile.rendererStats?.visibleNodes).toBe(1);
  await expect(page.getByTestId('graph-canvas')).toBeVisible();
});
