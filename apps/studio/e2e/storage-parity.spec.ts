/**
 * 11D browser gate: the shared runtime-parity suite runs over the real OPFS
 * worker backend (the identical scenario objects vitest runs against
 * better-sqlite3 — packages/store-sqlite/src/parity.ts), and OPFS
 * unavailability falls back cleanly to an in-memory + export session
 * (ADR-0038 §7: persistence is an enhancement, never a correctness
 * requirement).
 */
import { expect, test } from '@playwright/test';

test.describe('storage runtime parity (ADR-0038, 11D)', () => {
  test('every shared scenario passes over the OPFS worker backend', async ({ page }) => {
    test.setTimeout(180_000); // several open/close cycles, each booting the wasm worker
    await page.goto('/?e2e=1', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__MERIDIAN_STORAGE_PARITY__ !== undefined);

    const outcomes = await page.evaluate(() => window.__MERIDIAN_STORAGE_PARITY__!.run());
    const failed = outcomes.filter((o) => !o.ok);
    expect(failed, failed.map((f) => `${f.name}: ${f.detail ?? ''}`).join('\n\n')).toEqual([]);
    expect(outcomes.length).toBeGreaterThanOrEqual(6);
  });

  test('OPFS unavailable → clean in-memory fallback with working export', async ({ page }) => {
    await page.goto('/?e2e=1', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__MERIDIAN_STORAGE_PARITY__ !== undefined);

    const result = await page.evaluate(() => window.__MERIDIAN_STORAGE_PARITY__!.fallback());
    expect(result.mode).toBe('memory');
    expect(result.storeWorks).toBe(true);
    expect(result.exportWorks).toBe(true);
  });
});
