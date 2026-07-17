import { expectedUnitFor } from './dashboard.mjs';

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Validate retained dashboards and construct (without writing) one measured
 * baseline. Artifact I/O stays in the CLI so every trust rule is unit-testable. */
export function calibrateDashboards(dashboards, { profile, budgets, generatedAt = new Date().toISOString() }) {
  if (dashboards.length < 3) throw new Error('baseline calibration requires at least three independent pinned-runner dashboards');
  const budgetIds = Object.entries(budgets)
    .filter(([id, value]) => id !== 'comment' && typeof value === 'number')
    .map(([id]) => id)
    .sort();
  const runIds = new Set(dashboards.map((dashboard) => dashboard.run?.id));
  if (runIds.size !== dashboards.length || runIds.has(undefined)) {
    throw new Error('every input must be a distinct dashboard run');
  }
  const runnerClasses = new Set(dashboards.map((dashboard) => dashboard.run?.runner?.declaredClass));
  if (runnerClasses.size !== 1 || runnerClasses.has(undefined)) {
    throw new Error('all dashboards must declare the same pinned runner class');
  }
  if (dashboards[0].run.runner.declaredClass !== profile.declaredClass) {
    throw new Error(`dashboard runner is ${dashboards[0].run.runner.declaredClass}, expected ${profile.declaredClass}`);
  }
  const commits = new Set(dashboards.map((dashboard) => dashboard.run?.commit));
  if (commits.size !== 1 || commits.has(undefined) || commits.has('unknown')) {
    throw new Error('all dashboards must come from the same known commit');
  }
  for (const dashboard of dashboards) {
    if (dashboard.schemaVersion !== 1) throw new Error(`${dashboard.run?.id ?? 'unknown run'}: unsupported dashboard schema`);
    if (!/^\d+\.\d+$/u.test(dashboard.run.id)) throw new Error(`${dashboard.run.id}: expected a GitHub run id/attempt`);
    if (dashboard.run.runner.matchesExpected !== true) throw new Error(`${dashboard.run.id}: runner did not match its pinned profile`);
    if (dashboard.run.runner.githubActions !== true || dashboard.run.runner.githubImage !== profile.githubImage) {
      throw new Error(`${dashboard.run.id}: runner lacks expected GitHub Actions ${profile.githubImage} provenance`);
    }
    if (dashboard.summary.absoluteFail !== 0 || dashboard.summary.scenarioFail !== 0 || dashboard.summary.notMeasured !== 0) {
      throw new Error(`${dashboard.run.id}: only complete green runs may calibrate a baseline`);
    }
    const ids = dashboard.metrics.map((metric) => metric.id).sort();
    if (JSON.stringify(ids) !== JSON.stringify(budgetIds)) {
      throw new Error(`${dashboard.run.id}: metric set does not exactly match the current budget manifest`);
    }
    for (const metric of dashboard.metrics) {
      if (!Number.isFinite(metric.value) || metric.value < 0 || metric.absoluteStatus !== 'pass') {
        throw new Error(`${dashboard.run.id}: metric ${metric.id} is not measured and green`);
      }
      if (metric.unit !== expectedUnitFor(metric.id)) {
        throw new Error(`${dashboard.run.id}: metric ${metric.id} has unit ${metric.unit}, expected ${expectedUnitFor(metric.id)}`);
      }
    }
    for (const id of profile.externalMetrics) {
      const metric = dashboard.metrics.find((candidate) => candidate.id === id);
      if (!metric?.sources?.includes(profile.externalSource)) {
        throw new Error(`${dashboard.run.id}: Studio-owned metric ${id} lacks ${profile.externalSource} provenance`);
      }
    }
  }

  const metrics = {};
  for (const id of budgetIds) {
    const rows = dashboards.map((dashboard) => dashboard.metrics.find((metric) => metric.id === id));
    metrics[id] = {
      value: median(rows.map((row) => row.value)),
      unit: expectedUnitFor(id),
    };
  }
  return {
    schemaVersion: 1,
    status: 'measured',
    runnerClass: dashboards[0].run.runner.declaredClass,
    generatedAt,
    sourceRuns: dashboards.map((dashboard) => ({ id: dashboard.run.id, commit: dashboard.run.commit })),
    aggregation: 'median',
    metrics,
  };
}
