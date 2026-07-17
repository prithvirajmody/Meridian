import { expect, test } from '@playwright/test';
import { boot } from './support.js';

test('large streamed ingest stays task-responsive and reports a bounded peak', async ({ page }) => {
  test.setTimeout(90_000);
  await boot(page);

  const result = await page.evaluate(async () => {
    const text = Array.from(
      { length: 6_000 },
      (_, index) => `# Stream section ${index}\n\nParagraph ${index}.`,
    ).join('\n\n');
    let taskHeartbeats = 0;
    let sawProgressElement = false;
    const timer = setInterval(() => {
      taskHeartbeats += 1;
      sawProgressElement ||= document.querySelector('[data-testid="ingest-progress"]') !== null;
    }, 0);
    await window.__MERIDIAN_STUDIO__!.openText('stream-large.md', text);
    clearInterval(timer);
    return {
      taskHeartbeats,
      sawProgressElement,
      phase: window.__MERIDIAN_STUDIO__!.state().phase,
      progress: window.__MERIDIAN_STUDIO__!.state().ingestProgress,
    };
  });

  expect(result.phase).toBe('ready');
  expect(result.taskHeartbeats).toBeGreaterThan(2);
  expect(result.sawProgressElement).toBe(true);
  expect(result.progress?.appliedOps).toBeGreaterThan(1_024);
  expect(result.progress?.peakBufferedOps).toBeLessThanOrEqual(1_024);
});
