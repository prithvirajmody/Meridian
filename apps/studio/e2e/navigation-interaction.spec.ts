/**
 * 6D chrome interaction: the search box flies to hits (never drills), the
 * breadcrumb bar pops context, the minimap recenters the camera, keyboard
 * verbs dispatch through the ADR-0025 table, and the saturation affordance
 * appears at z = 1.
 */
import { expect, test } from '@playwright/test';
import { boot, openCorpus, settleFrames, waitForSettled, zoomStep } from './support.js';

test('search box: typing surfaces ranked hits; selecting flies to the node and sets focus', async ({ page }) => {
  await boot(page);
  await openCorpus(page, 'links.md');

  await page.getByTestId('search-input').fill('appendix');
  await expect(page.getByTestId('search-results')).toBeVisible();
  const depthBefore = (await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state().nav!)).depth;
  await page.getByTestId('search-hit').first().click();
  await page.waitForFunction(() => !window.__MERIDIAN_STUDIO__!.transitionActive());
  const nav = await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state().nav!);
  expect(nav.focus).not.toBeNull();
  expect(nav.depth).toBe(depthBefore); // fly-to never drills (ADR-0025)
});

test('breadcrumb bar: drill-in grows the trail; clicking the root crumb pops back', async ({ page }) => {
  await boot(page);
  await openCorpus(page, 'basic.md');
  const target = await page.evaluate(() => window.__MERIDIAN_STUDIO__!.navExpandable()[0]!);
  await page.evaluate((nodeId) => window.__MERIDIAN_STUDIO__!.navDrillIn(nodeId), target);
  await waitForSettled(page, 1);
  await expect(page.getByTestId('breadcrumb-1')).toBeVisible();

  await page.getByTestId('breadcrumb-0').click();
  await page.waitForFunction(() => !window.__MERIDIAN_STUDIO__!.transitionActive());
  const nav = await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state().nav!);
  expect(nav.depth).toBe(1);
  await expect(page.getByTestId('breadcrumb-1')).toHaveCount(0);
});

test('minimap: visible with a viewport rect; clicking recenters the camera', async ({ page }) => {
  await boot(page);
  await openCorpus(page, 'basic.md');
  await expect(page.getByTestId('minimap')).toBeVisible();
  await expect(page.getByTestId('minimap-viewport')).toBeVisible();

  const before = await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state().camera);
  const box = (await page.getByTestId('minimap').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.15, box.y + box.height * 0.2);
  await settleFrames(page);
  const after = await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state().camera);
  expect(after.scale).toBeCloseTo(before.scale, 6); // recenter never rescales
  expect(Math.hypot(after.center.x - before.center.x, after.center.y - before.center.y)).toBeGreaterThan(0);
});

test('keyboard verbs: + zooms semantically, Space expands in place, Escape drills out', async ({ page }) => {
  await boot(page);
  await openCorpus(page, 'basic.md');

  const zoomBefore = (await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state().nav!)).zoom;
  await page.keyboard.press('+');
  await page.waitForFunction(() => !window.__MERIDIAN_STUDIO__!.transitionActive());
  const zoomAfter = (await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state().nav!)).zoom;
  expect(zoomAfter).toBeGreaterThan(zoomBefore);

  // Space with a selection toggles expand-in-place (ADR-0012 override).
  const expanded = await page.evaluate(() => {
    const api = window.__MERIDIAN_STUDIO__!;
    const target = api.navExpandable()[0]!;
    api.navKey(' ', target);
    return target;
  });
  await waitForSettled(page, 1);
  const url = await page.evaluate(() => window.__MERIDIAN_STUDIO__!.navUrl());
  expect(url).toContain('ov=');
  expect(url).toContain(encodeURIComponent(expanded).slice(0, 8));

  // Escape at the root is a located no-op with a notice, never a throw.
  await page.keyboard.press('Escape');
  const nav = await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state().nav!);
  expect(nav.depth).toBe(1);
  expect(nav.notice?.code).toBe('at-root');
});

test('saturation affordance: at z = 1 the bar says zoom is geometric-only', async ({ page }) => {
  await boot(page);
  await openCorpus(page, 'basic.md');
  for (let step = 0; step < 8; step++) await zoomStep(page, 2, 640, 400);
  const nav = await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state().nav!);
  expect(nav.saturated).toBe(true);
  await expect(page.getByTestId('breadcrumb-meta')).toContainText('finest');
});
