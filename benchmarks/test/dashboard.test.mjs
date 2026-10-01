import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  baselineRequirementFailures,
  buildDashboard,
  completenessFailures,
  expectedUnitFor,
  externalProducerState,
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

describe('Studio producer coupling (CI e2e step outcome)', () => {
  const budgets = { 'node-latency-ms': 100, 'studio-frame-p95-ms': 18, 'studio-min-fps': 55 };
  const studioIds = ['studio-frame-p95-ms', 'studio-min-fps'];
  const run = { id: 'test', commit: 'abc', runner: { declaredClass: 'test', os: 'linux', arch: 'x64', node: '24' } };
  const nodeRow = { id: 'node-latency-ms', value: 40, unit: 'ms', source: 'node.bench.mjs' };
  const build = (measurements, skippedMetricIds) => buildDashboard({
    budgets,
    measurements,
    baseline: { schemaVersion: 1, status: 'unmeasured', metrics: {} },
    relativeTolerance: 0.15,
    run,
    scenarios: [],
    skippedMetricIds,
  });
  const strict = { requireExternal: true, requireAll: true };

  it('classifies GitHub step outcomes and rejects anything else', () => {
    assert.equal(externalProducerState(undefined), 'unreported');
    assert.equal(externalProducerState(''), 'unreported');
    assert.equal(externalProducerState('skipped'), 'skipped');
    for (const outcome of ['success', 'failure', 'cancelled']) {
      assert.equal(externalProducerState(outcome), 'ran');
    }
    for (const typo of ['Skipped', 'true', '1', 'skip']) {
      assert.throws(() => externalProducerState(typo), /must be one of success, failure, cancelled, skipped/u);
    }
  });

  it('e2e skipped: Studio rows are reported as skipped, not missing, and do not fail', () => {
    const dashboard = build([nodeRow], studioIds);
    for (const id of studioIds) {
      const metric = dashboard.metrics.find((row) => row.id === id);
      assert.equal(metric.value, null);
      assert.equal(metric.absoluteStatus, 'skipped');
      assert.equal(metric.relative.status, 'skipped');
    }
    assert.equal(dashboard.summary.skipped, 2);
    assert.equal(dashboard.summary.notMeasured, 0);
    assert.equal(dashboard.summary.absoluteFail, 0);
    assert.deepEqual(completenessFailures(dashboard, { ...strict, externalStatus: 'skipped' }), {
      externalMissing: false,
      missingAbsolute: [],
    });
    assert.deepEqual(baselineRequirementFailures(dashboard.metrics, { schemaVersion: 1, status: 'measured' }), [
      { id: 'node-latency-ms', status: 'not-calibrated' },
    ]);
    const markdown = renderMarkdown(dashboard);
    assert.match(markdown, /0 not measured, 2 skipped/u);
    assert.match(markdown, /\| `studio-min-fps` \| — \| ≥ 55\.00 fps \| skipped \| skipped \| — \|/u);
    assert.match(markdown, /2 metrics skipped:\*\* .*`studio-frame-p95-ms`, `studio-min-fps`/u);
  });

  it('e2e skipped still fails a missing or failing Node row', () => {
    const missing = build([], studioIds);
    assert.deepEqual(completenessFailures(missing, { ...strict, externalStatus: 'skipped' }).missingAbsolute, ['node-latency-ms']);
    const failing = build([{ ...nodeRow, value: 400 }], studioIds);
    assert.equal(failing.summary.absoluteFail, 1);
  });

  it('e2e ran: an absent or incomplete studio.json still fails', () => {
    const absent = build([nodeRow], []);
    assert.equal(absent.summary.skipped, 0);
    assert.deepEqual(completenessFailures(absent, { ...strict, externalStatus: 'not-measured' }), {
      externalMissing: true,
      missingAbsolute: studioIds,
    });
    const partial = build([nodeRow, { id: 'studio-min-fps', value: 60, unit: 'fps', source: 'studio-playwright' }], []);
    assert.deepEqual(completenessFailures(partial, { ...strict, externalStatus: 'fail' }), {
      externalMissing: true,
      missingAbsolute: ['studio-frame-p95-ms'],
    });
  });

  it('a skipped id that was measured anyway is gated normally', () => {
    const dashboard = build([nodeRow, { id: 'studio-min-fps', value: 30, unit: 'fps', source: 'studio-playwright' }], studioIds);
    const fps = dashboard.metrics.find((row) => row.id === 'studio-min-fps');
    assert.equal(fps.absoluteStatus, 'fail');
    assert.equal(dashboard.summary.skipped, 1);
  });
});

describe('report-only perf budgets (MERIDIAN_PERF_GATES=report)', () => {
  const budgets = { 'edit-latency-ms': 1000, 'scroll-min-fps': 55, 'other-latency-ms': 100 };
  const run = { id: 'test', commit: 'abc', runner: { declaredClass: 'test', os: 'linux', arch: 'x64', node: '24' } };
  const overBudget = [
    { id: 'edit-latency-ms', value: 1330.8, unit: 'ms', source: 'studio-playwright' },
    { id: 'scroll-min-fps', value: 18.5, unit: 'fps', source: 'studio-playwright' },
    { id: 'other-latency-ms', value: 40, unit: 'ms', source: 'node.bench.mjs' },
  ];
  const build = (measurements, perfGates, reportOnlyMetricIds = ['edit-latency-ms', 'scroll-min-fps']) => buildDashboard({
    budgets,
    measurements,
    baseline: { schemaVersion: 1, status: 'unmeasured', metrics: {} },
    relativeTolerance: 0.15,
    run,
    scenarios: [],
    perfGates,
    reportOnlyMetricIds,
  });
  const byId = (dashboard, id) => dashboard.metrics.find((metric) => metric.id === id);

  it('report mode records exceeded report-only budgets without failing', () => {
    const dashboard = build(overBudget, 'report');
    assert.equal(byId(dashboard, 'edit-latency-ms').absoluteStatus, 'report-only-fail');
    assert.equal(byId(dashboard, 'edit-latency-ms').value, 1330.8);
    assert.equal(byId(dashboard, 'edit-latency-ms').reportOnly, true);
    assert.equal(byId(dashboard, 'scroll-min-fps').absoluteStatus, 'report-only-fail');
    assert.equal(byId(dashboard, 'other-latency-ms').absoluteStatus, 'pass');
    assert.equal(dashboard.summary.reportOnlyFail, 2);
    assert.equal(dashboard.summary.absoluteFail, 0);
    assert.equal(dashboard.policy.perfGates, 'report');
    assert.deepEqual(dashboard.policy.reportOnlyMetrics, ['edit-latency-ms', 'scroll-min-fps']);
    const markdown = renderMarkdown(dashboard);
    assert.match(markdown, /2 over budget \(report-only\)/u);
    assert.match(markdown, /\| `scroll-min-fps` \| 18\.50 fps \| ≥ 55\.00 fps \| over budget \(report-only\) \|/u);
    assert.match(markdown, /2 report-only budgets exceeded.*`edit-latency-ms` 1330\.80 ms vs ≤ 1000\.00 ms/u);
  });

  it('enforce mode (the default) fails the same values exactly as before', () => {
    for (const perfGates of ['enforce', undefined]) {
      const dashboard = build(overBudget, perfGates);
      assert.equal(byId(dashboard, 'edit-latency-ms').absoluteStatus, 'fail');
      assert.equal(byId(dashboard, 'edit-latency-ms').reportOnly, undefined);
      assert.equal(dashboard.summary.absoluteFail, 2);
      assert.equal(dashboard.summary.reportOnlyFail, 0);
      assert.deepEqual(dashboard.policy.reportOnlyMetrics, []);
    }
  });

  it('report mode still fails unlisted budgets, unit errors, and missing rows', () => {
    const unlisted = build([...overBudget.slice(0, 2), { ...overBudget[2], value: 400 }], 'report');
    assert.equal(byId(unlisted, 'other-latency-ms').absoluteStatus, 'fail');
    assert.equal(unlisted.summary.absoluteFail, 1);
    const wrongUnit = build([{ ...overBudget[0], unit: 's' }, ...overBudget.slice(1)], 'report');
    assert.equal(byId(wrongUnit, 'edit-latency-ms').absoluteStatus, 'invalid');
    assert.equal(wrongUnit.summary.absoluteFail, 1);
    const missing = build(overBudget.slice(1), 'report');
    assert.equal(byId(missing, 'edit-latency-ms').absoluteStatus, 'not-measured');
    assert.deepEqual(completenessFailures(missing, { externalStatus: 'fail', requireExternal: true, requireAll: true }), {
      externalMissing: true,
      missingAbsolute: ['edit-latency-ms'],
    });
  });

  it('relative gates follow the same rule and the strict baseline check skips report-only rows', () => {
    const dashboard = buildDashboard({
      budgets,
      measurements: overBudget,
      baseline: {
        schemaVersion: 1,
        status: 'measured',
        runnerClass: 'test',
        metrics: {
          'edit-latency-ms': { value: 900, unit: 'ms' },
          'scroll-min-fps': { value: 60, unit: 'fps' },
          'other-latency-ms': { value: 20, unit: 'ms' },
        },
      },
      relativeTolerance: 0.15,
      run,
      scenarios: [],
      perfGates: 'report',
      reportOnlyMetricIds: ['edit-latency-ms', 'scroll-min-fps'],
    });
    assert.equal(byId(dashboard, 'edit-latency-ms').relative.status, 'report-only-fail');
    assert.equal(byId(dashboard, 'other-latency-ms').relative.status, 'fail');
    assert.equal(dashboard.summary.relativeFail, 1);
    assert.deepEqual(baselineRequirementFailures(dashboard.metrics, { schemaVersion: 1, status: 'measured' }), [
      { id: 'other-latency-ms', status: 'fail' },
    ]);
  });
});
