import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { encodeProjectBundle } from '@meridian/adapter-code';
import { boot } from './support.js';

const FILES = 1_000;
const LINES_PER_FILE = 1_000;
const FIXTURE_SHA256 = '158a80e54f69cd30e4a76fab2bbbb86a289be8530d21d05d181cd93b51b2e886';
const MAX_RETAINED_HEAP_GROWTH_BYTES = 256 * 1024 * 1024;
const bundle = encodeProjectBundle({
  root: 'synthetic-monorepo',
  files: Array.from({ length: FILES }, (_, index) => ({
    path: `packages/p${String(index).padStart(4, '0')}/src/index.ts`,
    text: '// synthetic\n'.repeat(LINES_PER_FILE),
  })),
});

test('literal 1M-LOC code stream keeps Studio responsive with bounded visible progress', async ({ page }) => {
  test.setTimeout(180_000);
  expect(createHash('sha256').update(bundle).digest('hex')).toBe(FIXTURE_SHA256);
  await boot(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  const heapBefore = await cdp.send('Runtime.getHeapUsage');

  const result = await page.evaluate(async (projectBundle) => {
    let taskHeartbeats = 0;
    let sawProgressElement = false;
    let maxHeartbeatGapMs = 0;
    let lastHeartbeatAt = performance.now();
    const timer = setInterval(() => {
      const heartbeatAt = performance.now();
      maxHeartbeatGapMs = Math.max(maxHeartbeatGapMs, heartbeatAt - lastHeartbeatAt);
      lastHeartbeatAt = heartbeatAt;
      taskHeartbeats += 1;
      sawProgressElement ||= document.querySelector('[data-testid="ingest-progress"]') !== null;
    }, 0);
    await window.__MERIDIAN_STUDIO__!.openText('phase11.meridian-code-project', projectBundle);
    clearInterval(timer);
    const state = window.__MERIDIAN_STUDIO__!.state();
    return {
      taskHeartbeats,
      maxHeartbeatGapMs,
      sawProgressElement,
      phase: state.phase,
      adapter: state.adapter,
      progress: state.ingestProgress,
      nodes: state.nodeIds.length,
      message: state.message,
    };
  }, bundle);

  expect(result.phase, result.message).toBe('ready');
  expect(result.adapter?.domain).toBe('code');
  expect(result.taskHeartbeats).toBeGreaterThan(10);
  expect(result.maxHeartbeatGapMs).toBeLessThan(250);
  expect(result.sawProgressElement).toBe(true);
  expect(result.progress?.appliedOps).toBeGreaterThan(1_024);
  expect(result.progress?.peakBufferedOps).toBeLessThanOrEqual(1_024);
  expect(result.nodes).toBeGreaterThan(0);
  await cdp.send('HeapProfiler.collectGarbage');
  const heapAfter = await cdp.send('Runtime.getHeapUsage');
  expect(Math.max(0, heapAfter.usedSize - heapBefore.usedSize)).toBeLessThanOrEqual(
    MAX_RETAINED_HEAP_GROWTH_BYTES,
  );
});
