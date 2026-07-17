/**
 * The 6D transition FPS gate, in the style of the 5F sampler: run a live
 * scripted descent/ascent, collect the renderer's per-frame draw times
 * observed during flights (telemetry `drawTimesMs`), and gate
 * p95 ≤ 22ms (`transition-frame-p95-ms`). Also prints plan/layout/drift
 * numbers so the gate output is a real measurement record.
 */
import { expect, test } from '@playwright/test';
import { boot, openCorpus, percentile95, recordStudioBenchmarkMetrics, telemetry, UI_BUDGETS, zoomStep } from './support.js';

test('transition p95 frame time ≤ 22ms across a live basic.md descent/ascent', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  await openCorpus(page, 'basic.md');

  const anchor = { x: 660, y: 360 };
  for (let step = 0; step < 8; step++) await zoomStep(page, 2, anchor.x, anchor.y);
  for (let step = 0; step < 8; step++) await zoomStep(page, 0.5, anchor.x, anchor.y);

  const records = await telemetry(page);
  const settled = records.filter((record) => record.settledAtMs !== null);
  expect(settled.length).toBeGreaterThanOrEqual(4);

  const drawTimes = settled.flatMap((record) => [...record.drawTimesMs]);
  expect(drawTimes.length).toBeGreaterThan(20);
  const p95 = percentile95(drawTimes);
  const mean = drawTimes.reduce((sum, value) => sum + value, 0) / drawTimes.length;
  const guardTrips = settled.filter((record) => record.guardTripped).length;
  const maxDrift = Math.max(...settled.map((record) => record.maxDriftPx));
  const maxPlan = Math.max(...settled.map((record) => record.planMs));
  const maxLayout = Math.max(...settled.map((record) => record.layoutMs));
  const maxGestureToSettle = Math.max(
    ...settled.map((record) => record.gestureToSettleMs ?? 0),
  );

  console.log(
    `[6D transition-fps] transitions=${settled.length} framesSampled=${drawTimes.length} ` +
      `p95FrameTimeMs=${p95.toFixed(2)} meanFrameTimeMs=${mean.toFixed(2)} ` +
      `maxPlanMs=${maxPlan.toFixed(2)} maxLayoutMs=${maxLayout.toFixed(1)} ` +
      `maxDriftPx=${maxDrift.toFixed(3)} guardTrips=${guardTrips}`,
  );

  expect(p95).toBeLessThanOrEqual(UI_BUDGETS['transition-frame-p95-ms']);
  expect(maxDrift).toBeLessThan(UI_BUDGETS['transition-anchor-drift-px']);
  expect(maxGestureToSettle).toBeLessThanOrEqual(
    UI_BUDGETS['transition-max-plan-to-settle-ms'],
  );
  recordStudioBenchmarkMetrics([
    { id: 'transition-frame-p95-ms', value: p95, unit: 'ms', sampleCount: drawTimes.length },
    { id: 'transition-anchor-drift-px', value: maxDrift, unit: 'px', sampleCount: settled.length },
    { id: 'transition-max-plan-to-settle-ms', value: maxGestureToSettle, unit: 'ms', sampleCount: settled.length },
  ]);
  // Plan computation is part of the 300ms budget (ADR-0023) — and must stay
  // well inside the 20ms roadmap row on these corpus-sized cut diffs.
  expect(maxPlan).toBeLessThan(20);
});
