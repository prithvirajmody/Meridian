/**
 * 6E debug panel, end to end: behind `?debug=1` the tunables panel opens,
 * an edit to BASE_TRANSITION_MS reaches the *next* transition (deterministic
 * clock — the flight is over at exactly the tuned horizon), reset restores
 * the ADR defaults, and with the flag off the panel (and HUD) simply do not
 * exist — the debug surface must be invisible to the golden-covered UI.
 */
import { expect, test, type Page } from '@playwright/test';
import { boot, openCorpus, telemetry } from './support.js';

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

test.describe('6E tunables panel (debug flag on, deterministic clock)', () => {
  test('opens, edits BASE_TRANSITION_MS, and the next transition reflects it', async ({ page }) => {
    await boot(page, '?e2e=1&debug=1&clock=manual');
    await openCorpus(page, 'basic.md');

    // The panel is present alongside the FPS/heap HUD and opens on click.
    await expect(page.getByTestId('debug-hud')).toBeVisible();
    const panel = page.getByTestId('tunables-panel');
    await expect(panel).toBeVisible();
    await page.getByTestId('tunables-summary').click();
    const input = page.getByTestId('tunable-baseTransitionMs');
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('240'); // the frozen ADR-0023 default
    await expect(page.getByTestId('tunable-easing')).toHaveText('easeInOutCubic'); // view-only

    // Edit the session copy: 240 → 120.
    await input.fill('120');
    await expect(page.getByTestId('tunables-reset')).toBeEnabled();

    // The next transition carries the tuned duration…
    await startZoomTransition(page, 60);
    let records = await telemetry(page);
    expect(records.at(-1)!.durationMs).toBe(120);

    // …and on the injected clock it is *over* at exactly that horizon
    // (the ADR default 240 would still be mid-flight at t=120).
    await page.evaluate(() => window.__MERIDIAN_STUDIO__!.clockAdvance(120));
    expect(await page.evaluate(() => window.__MERIDIAN_STUDIO__!.transitionActive())).toBe(false);
    records = await telemetry(page);
    expect(records.at(-1)!.settledAtMs).not.toBeNull();

    // Reset restores the ADR defaults; the following transition is back on 240.
    await page.getByTestId('tunables-reset').click();
    await expect(input).toHaveValue('240');
    await expect(page.getByTestId('tunables-reset')).toBeDisabled();
    await startZoomTransition(page, 1 / 60);
    records = await telemetry(page);
    expect(records.at(-1)!.durationMs).toBe(240);
    await page.evaluate(() => window.__MERIDIAN_STUDIO__!.clockAdvance(1000));
    await page.waitForFunction(() => !window.__MERIDIAN_STUDIO__!.transitionActive());
  });

  test('a tuned degrade threshold flips the next transition to crossfade', async ({ page }) => {
    await boot(page, '?e2e=1&debug=1&clock=manual');
    await openCorpus(page, 'basic.md');
    await page.getByTestId('tunables-summary').click();
    await page.getByTestId('tunable-maxAnimatedNodes').fill('0');

    await startZoomTransition(page, 60);
    const records = await telemetry(page);
    expect(records.at(-1)!.mode).toBe('crossfade');
    expect(records.at(-1)!.degradeTriggers).toContain('animated-node-budget');
    await page.evaluate(() => window.__MERIDIAN_STUDIO__!.clockAdvance(1000));
    await page.waitForFunction(() => !window.__MERIDIAN_STUDIO__!.transitionActive());
  });
});

test.describe('debug flag off — the panel does not exist', () => {
  test('no tunables panel, no HUD, and the UI chrome is golden-identical', async ({ page }) => {
    await boot(page); // plain ?e2e=1 — the same boot the corpus goldens use
    await openCorpus(page, 'basic.md');
    await expect(page.getByTestId('tunables-panel')).toHaveCount(0);
    await expect(page.getByTestId('debug-hud')).toHaveCount(0);
    // The corpus-visual baselines themselves are re-asserted by
    // corpus-visual.spec.ts in this same suite run — flag-off pixels are
    // covered there against the unchanged 5F/6D goldens.
  });
});
