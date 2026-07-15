import { expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface UiBudgets {
  readonly 'renderer-frame-p95-ms': number;
  readonly 'renderer-throughput-min-fps': number;
  readonly 'renderer-first-render-ms': number;
  readonly 'renderer-interaction-p95-ms': number;
  readonly 'renderer-max-live-labels': number;
  readonly 'outline-scroll-min-fps': number;
  readonly 'studio-heap-soak-ms': number;
  readonly 'studio-heap-retained-growth-bytes': number;
  readonly 'transition-frame-p95-ms': number;
  readonly 'transition-anchor-drift-px': number;
  readonly 'transition-max-plan-to-settle-ms': number;
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

/** Serializable telemetry record shape (mirrors `TransitionRecord`). */
export interface TelemetryRecord {
  readonly seq: number;
  readonly trigger: string;
  readonly mode: 'choreographed' | 'crossfade' | 'camera-only';
  readonly planMs: number;
  readonly layoutMs: number;
  readonly durationMs: number;
  readonly settledAtMs: number | null;
  readonly gestureToSettleMs: number | null;
  readonly maxDriftPx: number;
  readonly anchored: boolean;
  readonly replannedFromFlight: boolean;
  readonly superseded: boolean;
  readonly guardTripped: boolean;
  readonly degradeTriggers: readonly string[];
  readonly drawTimesMs: readonly number[];
}

export async function telemetry(page: Page): Promise<readonly TelemetryRecord[]> {
  return (await page.evaluate(() =>
    window.__MERIDIAN_STUDIO__!.transitionTelemetry(),
  )) as unknown as readonly TelemetryRecord[];
}

/** Wait until no transition is in flight and telemetry has ≥ `count` records. */
export async function waitForSettled(page: Page, count: number): Promise<void> {
  await page.waitForFunction(
    (expected) => {
      const api = window.__MERIDIAN_STUDIO__!;
      return !api.transitionActive() && api.transitionTelemetry().length >= expected;
    },
    count,
    { timeout: 15_000 },
  );
}

/**
 * One semantic zoom step about a screen point, waiting for any resulting
 * transition to settle before the next step (a scripted descent/ascent).
 */
export async function zoomStep(page: Page, factor: number, x: number, y: number): Promise<void> {
  await page.evaluate(
    ({ factor: f, x: px, y: py }) => window.__MERIDIAN_STUDIO__!.navZoomBy(f, px, py),
    { factor, x, y },
  );
  await page.waitForFunction(() => !window.__MERIDIAN_STUDIO__!.transitionActive(), undefined, {
    timeout: 15_000,
  });
}
