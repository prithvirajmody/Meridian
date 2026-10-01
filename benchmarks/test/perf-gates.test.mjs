import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { perfGateMode, reportOnlyMetricIds } from '../lib/perf-gates.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const budgets = JSON.parse(readFileSync(resolve(ROOT, 'benchmarks/budgets.json'), 'utf8'));
const profile = JSON.parse(readFileSync(resolve(ROOT, 'benchmarks/runner.json'), 'utf8'));

describe('perf gate mode (MERIDIAN_PERF_GATES)', () => {
  it('enforces by default and accepts only enforce or report', () => {
    assert.equal(perfGateMode(undefined), 'enforce');
    assert.equal(perfGateMode(''), 'enforce');
    assert.equal(perfGateMode('enforce'), 'enforce');
    assert.equal(perfGateMode('report'), 'report');
    for (const typo of ['Report', 'report-only', '1', 'true', 'off']) {
      assert.throws(() => perfGateMode(typo), /MERIDIAN_PERF_GATES must be one of enforce, report/u);
    }
  });

  it('exempts nothing when enforcing, and only the profile list when reporting', () => {
    assert.deepEqual([...reportOnlyMetricIds('enforce', profile)], []);
    assert.deepEqual(
      [...reportOnlyMetricIds('report', profile)].sort(),
      [...profile.reportOnlyMetrics].sort(),
    );
    assert.throws(() => reportOnlyMetricIds('report', { reportOnlyMetrics: 'edit-to-pixel-p95-ms' }), /array of metric ids/u);
  });

  it('every report-only id is an existing budget, and the list is not every budget', () => {
    const budgetIds = Object.keys(budgets).filter((id) => typeof budgets[id] === 'number');
    assert.ok(profile.reportOnlyMetrics.length > 0);
    for (const id of profile.reportOnlyMetrics) assert.ok(budgetIds.includes(id), `${id} is not in budgets.json`);
    assert.ok(profile.reportOnlyMetrics.length < budgetIds.length);
  });
});
