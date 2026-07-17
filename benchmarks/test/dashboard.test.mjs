import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  baselineRequirementFailures,
  buildDashboard,
  expectedUnitFor,
  parseBudgetOutput,
  parseExternalResult,
  renderMarkdown,
} from '../lib/dashboard.mjs';

describe('benchmark result collector', () => {
  it('parses existing millisecond, ratio, and floor rows', () => {
    const rows = parseBudgetOutput(`
  PASS  cold-open-first-cut-ms  412.3ms  (budget ≤ 3000ms)
  PASS  layout-stability-small-delta-min  0.947  (budget ≥ 0.9)
  PASS  store-100-version-chain-min-node-share  99.91%  (budget ≥ 90%)
`, 'fixture');
    assert.deepEqual(rows.map(({ id, value, unit }) => ({ id, value, unit })), [
      { id: 'cold-open-first-cut-ms', value: 412.3, unit: 'ms' },
      { id: 'layout-stability-small-delta-min', value: 0.947, unit: 'ratio' },
      { id: 'store-100-version-chain-min-node-share', value: 0.9991, unit: 'ratio' },
    ]);
  });

  it('parses explicit throughput units and derives every Studio unit contract', () => {
    const [throughput] = parseBudgetOutput('  PASS  stream-ingest-min-nodes-per-second  1250nodes/s', 'fixture');
    assert.deepEqual(
      { value: throughput.value, unit: throughput.unit },
      { value: 1250, unit: 'nodes/s' },
    );
    assert.equal(expectedUnitFor('transition-anchor-drift-px'), 'px');
    assert.equal(expectedUnitFor('renderer-max-live-labels'), 'count');
    assert.equal(expectedUnitFor('studio-heap-retained-growth-bytes'), 'bytes');
  });

  it('validates the Studio external-result contract', () => {
    const rows = parseExternalResult({
      schemaVersion: 1,
      source: 'studio-playwright',
      metrics: [{ id: 'edit-to-pixel-p95-ms', value: 83.5, unit: 'ms', sampleCount: 100 }],
    });
    assert.equal(rows[0].source, 'studio-playwright');
    assert.throws(
      () => parseExternalResult({ schemaVersion: 1, source: 'studio', metrics: [{ id: 'x', value: NaN, unit: 'ms', sampleCount: 1 }] }),
      /finite non-negative/u,
    );
  });

  it('uses the worst duplicate result and applies max/min relative gates', () => {
    const dashboard = buildDashboard({
      budgets: { comment: 'x', 'latency-ms': 100, 'throughput-min-fps': 50 },
      measurements: [
        { id: 'latency-ms', value: 90, unit: 'ms', source: 'a' },
        { id: 'latency-ms', value: 110, unit: 'ms', source: 'b' },
        { id: 'throughput-min-fps', value: 48, unit: 'fps', source: 'a' },
      ],
      baseline: {
        schemaVersion: 1,
        status: 'measured',
        metrics: {
          'latency-ms': { value: 90, unit: 'ms' },
          'throughput-min-fps': { value: 60, unit: 'fps' },
        },
      },
      relativeTolerance: 0.15,
      run: { id: 'test', commit: 'abc', runner: { declaredClass: 'test', os: 'linux', arch: 'x64', node: '24' } },
      scenarios: [],
    });
    const latency = dashboard.metrics.find((metric) => metric.id === 'latency-ms');
    const throughput = dashboard.metrics.find((metric) => metric.id === 'throughput-min-fps');
    assert.equal(latency.value, 110);
    assert.equal(latency.absoluteStatus, 'fail');
    assert.equal(latency.relative.status, 'fail');
    assert.equal(throughput.absoluteStatus, 'fail');
    assert.equal(throughput.relative.status, 'fail');
    assert.match(renderMarkdown(dashboard), /Meridian benchmark dashboard/u);
  });

  it('does not compare a local run with a pinned-runner baseline', () => {
    const dashboard = buildDashboard({
      budgets: { 'latency-ms': 100 },
      measurements: [{ id: 'latency-ms', value: 50, unit: 'ms', source: 'fixture' }],
      baseline: { status: 'measured', runnerClass: 'pinned', metrics: { 'latency-ms': 40 } },
      relativeTolerance: 0.15,
      run: { id: 'test', commit: 'abc', runner: { declaredClass: 'local', os: 'linux', arch: 'x64', node: '24' } },
      scenarios: [],
    });
    assert.equal(dashboard.metrics[0].relative.status, 'runner-mismatch');
  });

  it('rejects measurement and baseline units that disagree with the metric id', () => {
    const dashboard = buildDashboard({
      budgets: { 'latency-ms': 100 },
      measurements: [{ id: 'latency-ms', value: 50, unit: 'seconds', source: 'fixture' }],
      baseline: {
        schemaVersion: 1,
        status: 'measured',
        runnerClass: 'test',
        metrics: { 'latency-ms': { value: 40, unit: 'seconds' } },
      },
      relativeTolerance: 0.15,
      run: { id: 'test', commit: 'abc', runner: { declaredClass: 'test', os: 'linux', arch: 'x64', node: '24' } },
      scenarios: [],
    });
    assert.equal(dashboard.metrics[0].absoluteStatus, 'invalid');
    assert.equal(dashboard.metrics[0].relative.status, 'invalid-baseline');
    assert.equal(dashboard.summary.absoluteFail, 1);
    assert.equal(dashboard.summary.relativeFail, 1);
  });

  it('strict baseline requirements reject every non-pass relative state', () => {
    const metrics = [
      { id: 'a', relative: { status: 'pass' } },
      { id: 'b', relative: { status: 'runner-mismatch' } },
      { id: 'c', relative: { status: 'invalid-baseline' } },
    ];
    assert.deepEqual(
      baselineRequirementFailures(metrics, { schemaVersion: 1, status: 'measured' }),
      [
        { id: 'b', status: 'runner-mismatch' },
        { id: 'c', status: 'invalid-baseline' },
      ],
    );
    assert.deepEqual(
      baselineRequirementFailures(metrics.slice(0, 1), { schemaVersion: 1, status: 'unmeasured' }),
      [{ id: '*', status: 'baseline-not-measured' }],
    );
  });
});
