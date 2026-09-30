/**
 * MERIDIAN_PERF_GATES for the Studio Playwright gates (e2e/perf-gates.ts):
 * enforce is the default, only `report` relaxes anything, and it relaxes only
 * the ids benchmarks/runner.json lists, the same set the bench collector uses.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { perfGateMode, reportOnlyMetricIds } from '../e2e/perf-gates.js';

const profile = JSON.parse(
  readFileSync(new URL('../../../benchmarks/runner.json', import.meta.url), 'utf8'),
) as { readonly reportOnlyMetrics: readonly string[] };

describe('Studio perf gate mode', () => {
  it('enforces by default and rejects anything but enforce or report', () => {
    expect(perfGateMode(undefined)).toBe('enforce');
    expect(perfGateMode('')).toBe('enforce');
    expect(perfGateMode('enforce')).toBe('enforce');
    expect(perfGateMode('report')).toBe('report');
    for (const typo of ['Report', 'report-only', '1', 'off']) {
      expect(() => perfGateMode(typo)).toThrow(/MERIDIAN_PERF_GATES must be one of enforce, report/);
    }
  });

  it('report mode exempts exactly the runner profile list; enforce exempts nothing', () => {
    expect([...reportOnlyMetricIds('enforce', profile)]).toEqual([]);
    expect([...reportOnlyMetricIds('report', profile)].sort()).toEqual([...profile.reportOnlyMetrics].sort());
    expect(() => reportOnlyMetricIds('report', { reportOnlyMetrics: [''] })).toThrow(/array of metric ids/);
  });
});
