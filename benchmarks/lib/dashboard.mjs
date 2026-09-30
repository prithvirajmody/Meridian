/**
 * Pure result normalization for the benchmark dashboard. Benchmark scripts
 * remain the owners of their scenarios; this module only turns their stable
 * PASS/FAIL rows (and browser-produced JSON) into one versioned artifact.
 */

const RESULT_LINE = /^\s*(PASS|FAIL)\s{2,}(\S+)\s{2,}(-?\d+(?:\.\d+)?)([A-Za-z%/]+)?(?:\s|$)/;

export const DASHBOARD_SCHEMA_VERSION = 1;
export const EXTERNAL_SCHEMA_VERSION = 1;

/** The values GitHub Actions reports as `steps.<id>.outcome`. */
export const STEP_OUTCOMES = Object.freeze(['success', 'failure', 'cancelled', 'skipped']);

/**
 * Classify the CI outcome of the step that produces the external (Studio)
 * result. Unset means nobody reported one (local runs): the require flags
 * apply unchanged. `skipped` means the producer never ran in this job, so its
 * rows are reported as skipped instead of missing. Any other outcome means it
 * ran, and a missing row stays a failure. Unknown values throw, so a typo
 * cannot silently relax the gate.
 */
export function externalProducerState(outcome) {
  if (outcome === undefined || outcome === '') return 'unreported';
  if (!STEP_OUTCOMES.includes(outcome)) {
    throw new Error(`external producer outcome must be one of ${STEP_OUTCOMES.join(', ')}; got ${JSON.stringify(outcome)}`);
  }
  return outcome === 'skipped' ? 'skipped' : 'ran';
}

export function directionFor(id) {
  return id.includes('-min') ? 'min' : 'max';
}

export function expectedUnitFor(id) {
  if (id.includes('nodes-per-second')) return 'nodes/s';
  if (id.endsWith('-ms')) return 'ms';
  if (id.endsWith('-fps')) return 'fps';
  if (id.includes('-share') || id.includes('-stability')) return 'ratio';
  if (id.endsWith('-bytes')) return 'bytes';
  if (id.endsWith('-px')) return 'px';
  if (id.includes('-nodes') || id.includes('-elements') || id.includes('-labels')) return 'count';
  return 'scalar';
}

export function unitFor(id, printedUnit) {
  if (printedUnit === '%') return 'ratio';
  return printedUnit ?? expectedUnitFor(id);
}

/** Parse the deliberately stable output rows emitted by existing *.bench.mjs. */
export function parseBudgetOutput(text, source) {
  const measurements = [];
  for (const line of text.split(/\r?\n/u)) {
    const match = RESULT_LINE.exec(line);
    if (match === null) continue;
    const printedUnit = match[4];
    const printedValue = Number(match[3]);
    measurements.push({
      id: match[2],
      value: printedUnit === '%' ? printedValue / 100 : printedValue,
      unit: unitFor(match[2], printedUnit),
      source,
      reportedStatus: match[1] === 'PASS' ? 'pass' : 'fail',
    });
  }
  return measurements;
}

/**
 * Validate a result produced outside Node (currently Studio Playwright).
 * Keeping this wire format tiny makes it straightforward for any harness to
 * contribute real measurements without importing benchmark implementation.
 */
export function parseExternalResult(input, sourcePath = 'external') {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${sourcePath}: expected a JSON object`);
  }
  if (input.schemaVersion !== EXTERNAL_SCHEMA_VERSION) {
    throw new Error(`${sourcePath}: schemaVersion must be ${EXTERNAL_SCHEMA_VERSION}`);
  }
  if (typeof input.source !== 'string' || input.source.length === 0) {
    throw new Error(`${sourcePath}: source must be a non-empty string`);
  }
  if (!Array.isArray(input.metrics)) {
    throw new Error(`${sourcePath}: metrics must be an array`);
  }
  return input.metrics.map((metric, index) => {
    const at = `${sourcePath}: metrics[${index}]`;
    if (metric === null || typeof metric !== 'object' || Array.isArray(metric)) {
      throw new Error(`${at} must be an object`);
    }
    if (typeof metric.id !== 'string' || metric.id.length === 0) {
      throw new Error(`${at}.id must be a non-empty string`);
    }
    if (typeof metric.value !== 'number' || !Number.isFinite(metric.value) || metric.value < 0) {
      throw new Error(`${at}.value must be a finite non-negative number`);
    }
    if (typeof metric.unit !== 'string' || metric.unit.length === 0) {
      throw new Error(`${at}.unit must be a non-empty string`);
    }
    if (!Number.isInteger(metric.sampleCount) || metric.sampleCount < 1) {
      throw new Error(`${at}.sampleCount must be a positive integer`);
    }
    return {
      id: metric.id,
      value: metric.value,
      unit: metric.unit,
      source: input.source,
      sampleCount: metric.sampleCount,
    };
  });
}

function baselineValue(entry) {
  if (typeof entry === 'number') return entry;
  if (entry !== null && typeof entry === 'object' && typeof entry.value === 'number') return entry.value;
  return undefined;
}

function aggregate(samples, direction) {
  if (samples.length === 0) return undefined;
  const values = samples.map((sample) => sample.value);
  return direction === 'min' ? Math.min(...values) : Math.max(...values);
}

export function buildDashboard({
  budgets,
  measurements,
  baseline,
  relativeTolerance,
  run,
  scenarios,
  skippedMetricIds = [],
}) {
  const skipped = new Set(skippedMetricIds);
  const byId = new Map();
  for (const measurement of measurements) {
    const bucket = byId.get(measurement.id) ?? [];
    bucket.push(measurement);
    byId.set(measurement.id, bucket);
  }

  const metrics = Object.entries(budgets)
    .filter(([id, value]) => id !== 'comment' && typeof value === 'number')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, budget]) => {
      const direction = directionFor(id);
      const samples = byId.get(id) ?? [];
      const value = aggregate(samples, direction);
      const unit = expectedUnitFor(id);
      const unitMismatch = samples.some((sample) => sample.unit !== unit);
      // A row whose producer did not run this job is skipped, never "missing".
      const wasSkipped = value === undefined && skipped.has(id);
      const absoluteStatus = value === undefined
        ? wasSkipped ? 'skipped' : 'not-measured'
        : unitMismatch
          ? 'invalid'
          : direction === 'min'
            ? value >= budget ? 'pass' : 'fail'
            : value <= budget ? 'pass' : 'fail';
      const baselineEntry = baseline?.metrics?.[id];
      const base = baselineValue(baselineEntry);
      const baselineUnit = baselineEntry !== null && typeof baselineEntry === 'object'
        ? baselineEntry.unit
        : undefined;
      let relative;
      if (value === undefined) {
        relative = { status: wasSkipped ? 'skipped' : 'not-measured' };
      } else if (baseline?.runnerClass !== undefined && baseline.runnerClass !== run.runner.declaredClass) {
        relative = { status: 'runner-mismatch', baselineRunnerClass: baseline.runnerClass };
      } else if (base === undefined) {
        relative = { status: 'not-calibrated' };
      } else if (!Number.isFinite(base) || base < 0 || baselineUnit !== unit) {
        relative = { status: 'invalid-baseline', baseline: base, baselineUnit: baselineUnit ?? null };
      } else if (base === 0) {
        relative = value === 0
          ? { status: 'pass', baseline: base, changeRatio: 0 }
          : { status: 'invalid-baseline', baseline: base };
      } else {
        const changeRatio = direction === 'min' ? (base - value) / base : (value - base) / base;
        relative = {
          status: changeRatio <= relativeTolerance ? 'pass' : 'fail',
          baseline: base,
          changeRatio,
        };
      }
      return {
        id,
        value: value ?? null,
        unit,
        direction,
        budget,
        absoluteStatus,
        relative,
        sampleCount: samples.reduce((total, sample) => total + (sample.sampleCount ?? 1), 0),
        sources: [...new Set(samples.map((sample) => sample.source))].sort(),
      };
    });

  const count = (field, status) => metrics.filter((metric) => metric[field] === status).length;
  const summary = {
    measured: metrics.filter((metric) => metric.value !== null).length,
    absolutePass: count('absoluteStatus', 'pass'),
    absoluteFail: count('absoluteStatus', 'fail') + count('absoluteStatus', 'invalid'),
    notMeasured: count('absoluteStatus', 'not-measured'),
    skipped: count('absoluteStatus', 'skipped'),
    relativePass: metrics.filter((metric) => metric.relative.status === 'pass').length,
    relativeFail: metrics.filter((metric) => metric.relative.status === 'fail' || metric.relative.status === 'invalid-baseline').length,
    relativeNotCalibrated: metrics.filter((metric) => metric.relative.status === 'not-calibrated').length,
    relativeRunnerMismatch: metrics.filter((metric) => metric.relative.status === 'runner-mismatch').length,
    scenarioFail: scenarios.filter((scenario) => scenario.status === 'fail').length,
  };

  return {
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    run,
    policy: {
      absoluteBudgetManifest: 'benchmarks/budgets.json',
      relativeTolerance,
      baselineStatus: baseline?.status ?? 'missing',
      baselineRunnerClass: baseline?.runnerClass ?? null,
    },
    summary,
    metrics,
    scenarios,
  };
}

/**
 * Run-level completeness requirements (`--require-external`, `--require-all`).
 * `externalStatus` is this run's Studio result state: pass, fail,
 * not-measured, or skipped. Skipped rows (their producer did not run in this
 * job) are never reported as missing; when the producer ran, an absent or
 * incomplete result still fails.
 */
export function completenessFailures(dashboard, { externalStatus, requireExternal, requireAll }) {
  const missingAbsolute = dashboard.metrics
    .filter((metric) => metric.absoluteStatus === 'not-measured')
    .map((metric) => metric.id);
  return {
    externalMissing: requireExternal && externalStatus !== 'pass' && externalStatus !== 'skipped',
    missingAbsolute: requireAll ? missingAbsolute : [],
  };
}

/** Strict relative-gate diagnostics. A calibrated run is acceptable only when
 * the baseline schema/status is valid and every current budget row compared
 * successfully on the same runner. Rows whose producer was skipped this job
 * are reported as skipped by the dashboard, not failed here. */
export function baselineRequirementFailures(metrics, baseline) {
  const failures = [];
  if (baseline?.schemaVersion !== 1) failures.push({ id: '*', status: 'invalid-baseline-schema' });
  if (baseline?.status !== 'measured') failures.push({ id: '*', status: 'baseline-not-measured' });
  for (const metric of metrics) {
    if (metric.relative.status === 'skipped') continue;
    if (metric.relative.status !== 'pass') failures.push({ id: metric.id, status: metric.relative.status });
  }
  return failures;
}

function shown(value, unit) {
  if (value === null || value === undefined) return '—';
  if (unit === 'ratio') return `${(value * 100).toFixed(2)}%`;
  if (unit === 'count' || unit === 'bytes') return Math.round(value).toLocaleString('en-US');
  return `${value.toFixed(2)}${unit === 'scalar' ? '' : ` ${unit}`}`;
}

function relativeText(relative) {
  if (relative.status === 'not-calibrated') return 'not calibrated';
  if (relative.status === 'not-measured') return 'not measured';
  if (relative.status === 'skipped') return 'skipped';
  if (relative.status === 'runner-mismatch') return 'different runner';
  if (relative.changeRatio === undefined) return relative.status;
  const sign = relative.changeRatio >= 0 ? '+' : '';
  return `${relative.status} (${sign}${(relative.changeRatio * 100).toFixed(1)}%)`;
}

export function renderMarkdown(dashboard) {
  const { run, summary } = dashboard;
  const lines = [
    '# Meridian benchmark dashboard',
    '',
    `- Run: \`${run.id}\``,
    `- Commit: \`${run.commit}\``,
    `- Runner: \`${run.runner.declaredClass}\` (${run.runner.os} ${run.runner.arch}, Node ${run.runner.node})`,
    `- Absolute: ${summary.absolutePass} pass, ${summary.absoluteFail} fail, ${summary.notMeasured} not measured, ${summary.skipped ?? 0} skipped`,
    `- Relative (±${(dashboard.policy.relativeTolerance * 100).toFixed(0)}%): ${summary.relativePass} pass, ${summary.relativeFail} fail, ${summary.relativeNotCalibrated} not calibrated, ${summary.relativeRunnerMismatch} different runner`,
    '',
    '| Metric | Value | Contract | Absolute | Relative | Source |',
    '|---|---:|---:|---|---|---|',
  ];
  for (const metric of dashboard.metrics) {
    const comparator = metric.direction === 'min' ? '≥' : '≤';
    lines.push(`| \`${metric.id}\` | ${shown(metric.value, metric.unit)} | ${comparator} ${shown(metric.budget, metric.unit)} | ${metric.absoluteStatus} | ${relativeText(metric.relative)} | ${metric.sources.join(', ') || '—'} |`);
  }
  lines.push('', '## Scenarios', '', '| Scenario | Duration | Exit | Status |', '|---|---:|---:|---|');
  for (const scenario of dashboard.scenarios) {
    lines.push(`| \`${scenario.id}\` | ${scenario.durationMs.toFixed(0)} ms | ${scenario.exitCode} | ${scenario.status} |`);
  }
  lines.push('');
  if ((summary.skipped ?? 0) > 0) {
    const skippedIds = dashboard.metrics
      .filter((metric) => metric.absoluteStatus === 'skipped')
      .map((metric) => `\`${metric.id}\``);
    lines.push(`> **${skippedIds.length} metrics skipped:** their producer did not run in this job, so they were not checked (neither pass nor fail): ${skippedIds.join(', ')}.`, '');
  }
  if (summary.relativeNotCalibrated > 0) {
    lines.push('> Relative rows marked “not calibrated” have no measured value in `benchmarks/baseline.json`; see `docs/PERFORMANCE-PROFILING.md` for the pinned-runner calibration procedure.', '');
  }
  return lines.join('\n');
}
