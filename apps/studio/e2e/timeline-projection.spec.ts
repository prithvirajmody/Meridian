import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { boot } from './support.js';

const markdown = readFileSync(
  new URL('../../../fixtures/corpora/markdown/basic.md', import.meta.url),
  'utf8',
);
const conversation = readFileSync(
  new URL('../../../fixtures/corpora/conversation/claude-basic.json', import.meta.url),
  'utf8',
);

async function openTimeline(page: Page, name: string, text: string): Promise<void> {
  await page.evaluate(
    async ([sourceName, sourceText]) => {
      await window.__MERIDIAN_STUDIO__!.openText(sourceName!, sourceText!);
      await window.__MERIDIAN_STUDIO__!.switchProjection('timeline');
    },
    [name, text],
  );
  await expect(page.getByTestId('pipeline-phase')).toHaveText('ready', { timeout: 30_000 });
  await page.waitForFunction(
    () => window.__MERIDIAN_STUDIO__!.projectionId() === 'timeline',
    undefined,
    { timeout: 30_000 },
  );
  await expect(page.getByTestId('canvas2d-projection')).toBeVisible();
  await expect(page.locator('.meridian-projection-canvas')).toHaveAttribute(
    'data-canvas-revision',
    /timeline-\d+/,
    { timeout: 10_000 },
  );
  await expect(page.getByTestId('graph-canvas')).toHaveCount(0);
}

test('timeline renders a conversation through its declared temporal metadata', async ({ page }) => {
  await boot(page);
  await openTimeline(page, 'conversation.json', conversation);
  expect((await page.evaluate(() => window.__MERIDIAN_STUDIO__!.state().adapter))?.domain).toBe(
    'conversation',
  );
  await expect(page.locator('.meridian-projection-canvas-message')).toBeHidden();
});

test('timeline on an atemporal domain degrades with a message, never crashes', async ({ page }) => {
  await boot(page);
  await openTimeline(page, 'timeline.md', markdown);
  const message = page.locator('.meridian-projection-canvas-message');
  await expect(message).toBeVisible();
  await expect(message).toContainText(/declares no time attributes/i);
  expect(await page.evaluate(() => window.__MERIDIAN_STUDIO__!.projectionId())).toBe('timeline');
  // Switching away still works after the degraded state.
  await page.evaluate(async () => {
    await window.__MERIDIAN_STUDIO__!.switchProjection('map');
  });
  await expect(page.getByTestId('graph-canvas')).toBeVisible();
});
