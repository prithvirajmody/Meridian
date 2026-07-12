/**
 * 6D scripted descents/ascents on three corpora (roadmap Phase 6 §12).
 * Real clock: the choreography runs live; gates come from the navigator's
 * measured telemetry — anchor drift < 8px per transition (ADR-0024),
 * plan-to-settle ≤ 300ms (ADR-0023/§16.1), and the drill/breadcrumb/URL
 * integrity checks from ADR-0025.
 */
import { expect, test } from '@playwright/test';
import { boot, openCorpus, telemetry, UI_BUDGETS, waitForSettled, zoomStep } from './support.js';

const DESCENT_CORPORA = ['basic.md', 'links.md', 'pathological-nesting.md'] as const;
const ANCHOR = { x: 700, y: 330 } as const; // off-center: exercises the affine map

for (const corpus of DESCENT_CORPORA) {
  test(`${corpus}: scripted descent and ascent stays within budgets, anchor held`, async ({ page }) => {
    test.setTimeout(120_000);
    await boot(page);
    await openCorpus(page, corpus);
    expect(await page.evaluate(() => window.__MERIDIAN_STUDIO__!.navActive())).toBe(true);

    // Descend to saturation, then ascend back to fit-all — through the same
    // wheel verb a user has (ADR-0025 continuous zoom). Step counts are
    // adaptive because each corpus derives its own scale range from layout.
    for (let step = 0; step < 16; step++) {
      await zoomStep(page, 2, ANCHOR.x, ANCHOR.y);
      if ((await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state())).nav!.zoom === 1) break;
    }
    expect((await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state())).nav!.zoom).toBe(1);
    for (let step = 0; step < 16; step++) {
      await zoomStep(page, 0.5, ANCHOR.x, ANCHOR.y);
      if ((await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state())).nav!.zoom === 0) break;
    }
    expect((await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state())).nav!.zoom).toBe(0);

    const records = await telemetry(page);
    const settled = records.filter((record) => record.settledAtMs !== null);
    expect(settled.length).toBeGreaterThan(0);

    const driftMax = Math.max(...settled.map((record) => record.maxDriftPx));
    const planMax = Math.max(...settled.map((record) => record.planMs));
    const settleMax = Math.max(...settled.map((record) => record.gestureToSettleMs ?? 0));
    const modes = settled.map((record) => record.mode);
    console.log(
      `[6D descent] ${corpus}: transitions=${settled.length} modes=${JSON.stringify(
        [...new Set(modes)],
      )} maxDriftPx=${driftMax.toFixed(3)} maxPlanMs=${planMax.toFixed(2)} maxPlanToSettleMs=${settleMax.toFixed(1)}`,
    );

    for (const record of settled) {
      expect(record.maxDriftPx, `drift seq=${record.seq}`).toBeLessThan(
        UI_BUDGETS['transition-anchor-drift-px'],
      );
      expect(record.durationMs, `duration seq=${record.seq}`).toBeLessThanOrEqual(
        UI_BUDGETS['transition-max-plan-to-settle-ms'],
      );
      expect(record.gestureToSettleMs ?? 0, `plan-to-settle seq=${record.seq}`).toBeLessThanOrEqual(
        UI_BUDGETS['transition-max-plan-to-settle-ms'],
      );
    }
    // Zoom transitions carry the pointer anchor (ADR-0024).
    expect(settled.some((record) => record.anchored)).toBe(true);
    // The descent choreographs (per-node tweens) at least once.
    expect(modes).toContain('choreographed');
    // links.md reliably trips plan-time degrade (ADR-0023): its cross-linked
    // sections re-layout with low stability, so the crossfade path is
    // exercised — and the degraded plan must say why (inspectable data).
    if (corpus === 'links.md') {
      const crossfades = settled.filter((record) => record.mode === 'crossfade');
      expect(crossfades.length).toBeGreaterThan(0);
      expect(crossfades[0]!.degradeTriggers.length).toBeGreaterThan(0);
    }
  });
}

test('the book descent (basic.md): drill-in/out stack integrity and URL round-trip', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  await openCorpus(page, 'basic.md');

  // Drill into the first expandable node (a node with a detail graph).
  const drilled = await page.evaluate(() => window.__MERIDIAN_STUDIO__!.navExpandable()[0] ?? null);
  expect(drilled).not.toBeNull();

  const before = await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state().nav!);
  await page.evaluate((nodeId) => window.__MERIDIAN_STUDIO__!.navDrillIn(nodeId), drilled!);
  await waitForSettled(page, 1);
  const after = await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state().nav!);
  // Breadcrumbs grew truthfully; drill-out restores the exact prior view.
  expect(after.depth).toBe(2);
  expect(after.breadcrumbs.length).toBe(2);
  expect(after.zoom).toBe(0); // ADR-0025: enter at z = 0
  await expect(page.getByTestId('breadcrumb-1')).toBeVisible();
  await page.evaluate(() => window.__MERIDIAN_STUDIO__!.navDrillOut());
  await page.waitForFunction(() => !window.__MERIDIAN_STUDIO__!.transitionActive());
  const restored = await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state().nav!);
  expect(restored.depth).toBe(1);
  expect(restored.zoom).toBeCloseTo(before.zoom, 6);

  // Drill into a node with no detail: a located no-op with a notice.
  const finestLeafProbe = await page.evaluate(() => {
    const api = window.__MERIDIAN_STUDIO__!;
    const expandable = new Set(api.navExpandable());
    const leaf = api.state().nodeIds.find((id) => !expandable.has(id));
    if (leaf === undefined) return null;
    api.navDrillIn(leaf);
    return api.state().nav!;
  });
  expect(finestLeafProbe).not.toBeNull();
  expect(finestLeafProbe!.depth).toBe(1);
  expect(finestLeafProbe!.notice?.code).toBe('no-detail');

  // URL round-trip: zoom somewhere specific, capture the fragment, reboot with
  // it, reopen the corpus, and the exact view restores (ADR-0025 gate).
  for (let step = 0; step < 4; step++) await zoomStep(page, 2, ANCHOR.x, ANCHOR.y);
  const view = await page.evaluate(() => {
    const api = window.__MERIDIAN_STUDIO__!;
    return { fragment: api.navUrl(), nav: api.state().nav!, camera: api.state().camera };
  });
  expect(view.fragment).toMatch(/^#g=/);
  expect(page.url()).toContain('#g='); // history.replaceState wired

  // A distinct query string forces a real document reload — a hash-only
  // navigation would keep the old runtime alive without the pending restore.
  await boot(page, `?e2e=1&restored=1${view.fragment}`);
  await openCorpus(page, 'basic.md');
  // The hash restore starts a transition once the navigator boots; wait for
  // it to settle rather than racing its async layout.
  await waitForSettled(page, 1);
  const restoredView = await page.evaluate(() => {
    const api = window.__MERIDIAN_STUDIO__!;
    return { nav: api.state().nav!, camera: api.state().camera };
  });
  expect(restoredView.nav.zoom).toBeCloseTo(view.nav.zoom, 6);
  expect(restoredView.nav.depth).toBe(view.nav.depth);
  expect(restoredView.camera.scale).toBeCloseTo(view.camera.scale, 4);
  expect(restoredView.camera.center.x).toBeCloseTo(view.camera.center.x, 4);
  expect(restoredView.camera.center.y).toBeCloseTo(view.camera.center.y, 4);
});
