/**
 * How the Studio Playwright gates apply perf budgets; mirrors
 * benchmarks/lib/perf-gates.mjs. `enforce` (the default) asserts every budget
 * exactly as before. `report` is set only by CI on GitHub-hosted runners: the
 * metrics listed in benchmarks/runner.json `reportOnlyMetrics` are measured and
 * recorded to studio.json, but their budgets are not asserted here; the bench
 * collector compares them with the unchanged budgets and reports any excess.
 */
export type PerfGateMode = 'enforce' | 'report';

export function perfGateMode(value: string | undefined): PerfGateMode {
  if (value === undefined || value === '' || value === 'enforce') return 'enforce';
  if (value === 'report') return 'report';
  throw new Error(`MERIDIAN_PERF_GATES must be one of enforce, report; got ${JSON.stringify(value)}`);
}

export function reportOnlyMetricIds(
  mode: PerfGateMode,
  profile: { readonly reportOnlyMetrics?: unknown },
): ReadonlySet<string> {
  if (mode !== 'report') return new Set();
  const ids = profile.reportOnlyMetrics ?? [];
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new Error('runner profile reportOnlyMetrics must be an array of metric ids');
  }
  return new Set(ids as string[]);
}
