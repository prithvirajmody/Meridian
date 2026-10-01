import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import { calibrateDashboards } from '../lib/calibration.mjs';
import { expectedUnitFor } from '../lib/dashboard.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const budgets = JSON.parse(readFileSync(resolve(ROOT, 'benchmarks/budgets.json'), 'utf8'));
const profile = JSON.parse(readFileSync(resolve(ROOT, 'benchmarks/runner.json'), 'utf8'));
const budgetEntries = Object.entries(budgets).filter(([id, value]) => id !== 'comment' && typeof value === 'number');

function dashboard(id, overrides = {}) {
  const metrics = budgetEntries.map(([metricId, budget]) => ({
    id: metricId,
    value: budget,
    unit: expectedUnitFor(metricId),
    absoluteStatus: 'pass',
    sources: profile.externalMetrics.includes(metricId) ? [profile.externalSource] : ['node-benchmark'],
  }));
  return {
    schemaVersion: 1,
    run: {
      id,
      commit: 'abc123',
      runner: {
        declaredClass: profile.declaredClass,
        matchesExpected: true,
        githubActions: true,
        githubImage: profile.githubImage,
      },
    },
    summary: { absoluteFail: 0, scenarioFail: 0, notMeasured: 0 },
    metrics,
    ...overrides,
  };
}

function calibration(inputs) {
  return calibrateDashboards(inputs, { profile, budgets, generatedAt: '2026-07-16T00:00:00.000Z' });
}

function rejected(inputs, pattern) {
  assert.throws(
    () => calibration(inputs),
    (error) => {
      assert.match(error.message, pattern);
      return true;
    },
  );
}

describe('pinned benchmark baseline calibration', () => {
  it('accepts three complete distinct GitHub runs from one commit', () => {
    const baseline = calibration([dashboard('100.1'), dashboard('101.1'), dashboard('102.1')]);
    assert.equal(baseline.status, 'measured');
    assert.equal(Object.keys(baseline.metrics).length, budgetEntries.length);
    assert.deepEqual(baseline.sourceRuns.map((run) => run.id), ['100.1', '101.1', '102.1']);
  });

  it('writes a measured baseline through the CLI wrapper', () => {
    const directory = mkdtempSync(join(tmpdir(), 'meridian-baseline-'));
    try {
      const inputs = [dashboard('100.1'), dashboard('101.1'), dashboard('102.1')].map((value, index) => {
        const path = resolve(directory, `dashboard-${index}.json`);
        writeFileSync(path, JSON.stringify(value));
        return path;
      });
      const output = resolve(directory, 'baseline.json');
      const stdout = execFileSync(
        process.execPath,
        [resolve(ROOT, 'benchmarks/calibrate-baseline.mjs'), '--out', output, ...inputs],
        { cwd: ROOT, encoding: 'utf8' },
      );
      const baseline = JSON.parse(readFileSync(output, 'utf8'));
      assert.equal(baseline.status, 'measured');
      assert.match(stdout, new RegExp(`wrote ${budgetEntries.length} measured baselines`, 'u'));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects an incomplete metric set', () => {
    const incomplete = dashboard('100.1');
    incomplete.metrics.pop();
    rejected([incomplete, dashboard('101.1'), dashboard('102.1')], /metric set does not exactly match/u);
  });

  it('rejects local provenance, mixed commits, and missing Studio ownership', () => {
    const local = dashboard('100.1');
    local.run.runner.githubActions = false;
    rejected([local, dashboard('101.1'), dashboard('102.1')], /lacks expected GitHub Actions/u);

    const mixed = dashboard('101.1');
    mixed.run.commit = 'different';
    rejected([dashboard('100.1'), mixed, dashboard('102.1')], /same known commit/u);

    const missingSource = dashboard('100.1');
    missingSource.metrics.find((metric) => metric.id === 'edit-to-pixel-p95-ms').sources = ['node-benchmark'];
    rejected([missingSource, dashboard('101.1'), dashboard('102.1')], /lacks studio-playwright provenance/u);
  });

  it('rejects a run whose Studio rows were skipped', () => {
    const skipped = dashboard('100.1');
    for (const metric of skipped.metrics) {
      if (!profile.externalMetrics.includes(metric.id)) continue;
      Object.assign(metric, { value: null, absoluteStatus: 'skipped', sources: [] });
    }
    skipped.summary.skipped = profile.externalMetrics.length;
    rejected([skipped, dashboard('101.1'), dashboard('102.1')], /is not measured and green/u);
  });
});
