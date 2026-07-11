import { expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface UiBudgets {
  readonly 'renderer-frame-p95-ms': number;
  readonly 'renderer-throughput-min-fps': number;
  readonly 'renderer-first-render-ms': number;
  readonly 'renderer-interaction-p95-ms': number;
  readonly 'renderer-max-live-labels': number;
  readonly 'studio-heap-soak-ms': number;
  readonly 'studio-heap-retained-growth-bytes': number;
}

export const UI_BUDGETS = JSON.parse(
  readFileSync(new URL('../../../benchmarks/budgets.json', import.meta.url), 'utf8'),
) as UiBudgets;

export const CORPUS_ROOT = fileURLToPath(
  new URL('../../../fixtures/corpora/markdown/', import.meta.url),
);

export const CORPORA = [
  'basic.md',
  'links.md',
  'commonmark-edges.md',
  'pathological-nesting.md',
  'no-headings.md',
  'empty.md',
] as const;

export async function boot(page: Page, query = '?e2e=1'): Promise<void> {
  await page.goto(`/${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__MERIDIAN_STUDIO__ !== undefined);
  await expect(page.getByTestId('canvas-island')).toBeVisible();
}

export async function openCorpus(page: Page, corpus: string): Promise<void> {
  await page.getByTestId('file-input').setInputFiles(`${CORPUS_ROOT}${corpus}`);
  await expect(page.getByTestId('pipeline-phase')).toHaveText('ready', { timeout: 30_000 });
  await page.waitForFunction(
    () => (window.__MERIDIAN_STUDIO__?.state().rendererStats?.frameCount ?? 0) > 0,
    undefined,
    { timeout: 30_000 },
  );
}

export async function settleFrames(page: Page, frames = 3): Promise<void> {
  await page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        let remaining = count;
        const step = (): void => {
          remaining--;
          if (remaining <= 0) resolve();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    frames,
  );
}

export function percentile95(values: readonly number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * 0.95) - 1)] ?? 0;
}
