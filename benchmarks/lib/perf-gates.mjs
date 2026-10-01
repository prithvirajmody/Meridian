/**
 * How perf budgets are applied. `enforce` (the default everywhere) fails on
 * any exceeded budget, exactly as before. `report` is set only by CI on
 * GitHub-hosted runners: the metrics listed in `benchmarks/runner.json`
 * `reportOnlyMetrics` are still measured, recorded, and compared against their
 * unchanged budgets, but an exceeded one is reported with a warning instead of
 * failing. Every other budget stays enforced in both modes.
 */
export const PERF_GATE_MODES = Object.freeze(['enforce', 'report']);

export function perfGateMode(value) {
  if (value === undefined || value === '') return 'enforce';
  if (!PERF_GATE_MODES.includes(value)) {
    throw new Error(`MERIDIAN_PERF_GATES must be one of ${PERF_GATE_MODES.join(', ')}; got ${JSON.stringify(value)}`);
  }
  return value;
}

/** The metric ids that are report-only in this mode (always empty when enforcing). */
export function reportOnlyMetricIds(mode, profile) {
  if (mode !== 'report') return new Set();
  const ids = profile?.reportOnlyMetrics ?? [];
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new Error('runner profile reportOnlyMetrics must be an array of metric ids');
  }
  return new Set(ids);
}
