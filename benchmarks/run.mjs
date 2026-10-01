#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { cpus, totalmem } from 'node:os';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  baselineRequirementFailures,
  buildDashboard,
  completenessFailures,
  externalProducerState,
  parseBudgetOutput,
  parseExternalResult,
  renderMarkdown,
} from './lib/dashboard.mjs';
import { perfGateMode, reportOnlyMetricIds } from './lib/perf-gates.mjs';

const benchmarkRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(benchmarkRoot, '..');
const SCENARIOS = [
  'decode-validate',
  'store-deltas',
  'ingest-markdown',
  'stream-ingest',
  'abstraction-cut',
  'layout-elk',
  'layout-force',
  'navigation-plan',
  'ai-replay-overhead',
  'ai-cluster-5k',
  'phase11-scale',
];

function parseArgs(argv) {
  const options = {
    outputDir: resolve(benchmarkRoot, 'results'),
    external: undefined,
    baseline: resolve(benchmarkRoot, 'baseline.json'),
    json: false,
    requireExternal: process.env.MERIDIAN_BENCH_REQUIRE_EXTERNAL === '1',
    requireAll: process.env.MERIDIAN_BENCH_REQUIRE_ALL === '1',
    requireBaseline: process.env.MERIDIAN_BENCH_REQUIRE_BASELINE === '1',
    requireRunner: process.env.MERIDIAN_BENCH_REQUIRE_RUNNER === '1',
    // CI outcome of the step that writes the external (Studio) result.
    externalOutcome: process.env.MERIDIAN_BENCH_EXTERNAL_OUTCOME,
    // enforce (default) or report; see lib/perf-gates.mjs.
    perfGates: process.env.MERIDIAN_PERF_GATES,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--require-external') options.requireExternal = true;
    else if (arg === '--require-all') options.requireAll = true;
    else if (arg === '--require-baseline') options.requireBaseline = true;
    else if (arg === '--require-runner') options.requireRunner = true;
    else if (arg === '--output-dir' || arg === '--external' || arg === '--baseline') {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${arg} requires a path`);
      const path = resolve(repoRoot, value);
      if (arg === '--output-dir') options.outputDir = path;
      else if (arg === '--external') options.external = path;
      else options.baseline = path;
    } else if (arg === '--external-outcome') {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${arg} requires a step outcome`);
      options.externalOutcome = value;
    } else if (arg === '--perf-gates') {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${arg} requires enforce or report`);
      options.perfGates = value;
    } else {
      throw new Error(`unknown benchmark option: ${arg}`);
    }
  }
  return options;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} ${path}: ${error.message}`);
  }
}

function gitCommit() {
  const fromEnvironment = process.env.GITHUB_SHA;
  if (fromEnvironment) return fromEnvironment;
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

function runnerMetadata(profile) {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const declaredClass = process.env.MERIDIAN_BENCH_RUNNER_CLASS
    ?? `local-${process.platform}-${process.arch}-node-${nodeMajor}`;
  return {
    declaredClass,
    expectedClass: profile.declaredClass,
    matchesExpected: declaredClass === profile.declaredClass
      && process.platform === profile.platform
      && process.arch === profile.arch
      && nodeMajor === profile.nodeMajor
      && process.env.GITHUB_ACTIONS === 'true'
      && process.env.ImageOS === profile.githubImage,
    os: process.platform,
    arch: process.arch,
    node: process.versions.node,
    cpu: cpus()[0]?.model ?? 'unknown',
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    githubImage: process.env.ImageOS ?? null,
    githubImageVersion: process.env.ImageVersion ?? null,
    githubActions: process.env.GITHUB_ACTIONS === 'true',
  };
}

let options;
let externalState;
let perfGates;
try {
  options = parseArgs(process.argv.slice(2));
  externalState = externalProducerState(options.externalOutcome);
  perfGates = perfGateMode(options.perfGates);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
}

const budgets = readJson(resolve(benchmarkRoot, 'budgets.json'), 'cannot read budget manifest');
const profile = readJson(resolve(benchmarkRoot, 'runner.json'), 'cannot read runner profile');
const reportOnly = reportOnlyMetricIds(perfGates, profile);
const baseline = existsSync(options.baseline)
  ? readJson(options.baseline, 'cannot read relative baseline')
  : { schemaVersion: 1, status: 'missing', runnerClass: profile.declaredClass, metrics: {} };
const runner = runnerMetadata(profile);
const log = options.json
  ? (text) => process.stderr.write(text)
  : (text) => process.stdout.write(text);
mkdirSync(options.outputDir, { recursive: true });

const measurements = [];
const scenarios = [];
for (const id of SCENARIOS) {
  const script = resolve(benchmarkRoot, `${id}.bench.mjs`);
  log(`\n━━ ${id} ━━\n`);
  const started = process.hrtime.bigint();
  const child = spawnSync(process.execPath, ['--expose-gc', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // Scenario owners decide their own exit code, so they get the resolved mode.
    env: { ...process.env, MERIDIAN_PERF_GATES: perfGates },
  });
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  const stdout = child.stdout ?? '';
  const processError = child.error instanceof Error ? `${child.error.message}\n` : '';
  const stderr = `${child.stderr ?? ''}${processError}`;
  log(stdout);
  if (stderr.length > 0) process.stderr.write(stderr);
  const parsed = parseBudgetOutput(stdout, `${id}.bench.mjs`);
  measurements.push(...parsed);
  const exitCode = child.error === undefined ? (child.status ?? 1) : 1;
  const status = exitCode === 0 && parsed.length > 0 ? 'pass' : 'fail';
  scenarios.push({ id, command: `node --expose-gc benchmarks/${id}.bench.mjs`, durationMs, exitCode, status, measurements: parsed.length });
  writeFileSync(resolve(options.outputDir, `${id}.log`), `${stdout}${stderr}`);
}

const externalPath = options.external ?? resolve(repoRoot, profile.externalResult);
let externalStatus = 'not-measured';
if (externalState === 'skipped') {
  // The producer did not run in this job, so a file at this path would be
  // left over from another run. Never mix it into this run's results.
  externalStatus = 'skipped';
  if (existsSync(externalPath)) {
    process.stderr.write(`ignoring ${externalPath}: its producer did not run in this job\n`);
  }
} else if (existsSync(externalPath)) {
  try {
    const externalMeasurements = parseExternalResult(readJson(externalPath, 'cannot read external result'), externalPath);
    measurements.push(...externalMeasurements);
    const expectedExternal = new Set(profile.externalMetrics ?? []);
    const actualExternal = new Set(
      externalMeasurements
        .filter((metric) => metric.source === profile.externalSource)
        .map((metric) => metric.id),
    );
    externalStatus = expectedExternal.size > 0
      && [...expectedExternal].every((id) => actualExternal.has(id))
      ? 'pass'
      : 'fail';
  } catch (error) {
    externalStatus = 'fail';
    process.stderr.write(`${error.message}\n`);
  }
}
scenarios.push({
  id: 'studio-external',
  command: externalPath,
  durationMs: 0,
  exitCode: externalStatus === 'fail' ? 1 : 0,
  status: externalStatus,
  measurements: measurements.filter((metric) => metric.source === 'studio-playwright').length,
});

const generatedAt = new Date().toISOString();
const dashboard = buildDashboard({
  budgets,
  measurements,
  baseline,
  relativeTolerance: profile.relativeTolerance,
  run: {
    id: process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_RUN_ID}.${process.env.GITHUB_RUN_ATTEMPT ?? '1'}`
      : `local-${generatedAt}`,
    generatedAt,
    commit: gitCommit(),
    runner,
  },
  scenarios,
  skippedMetricIds: externalState === 'skipped' ? profile.externalMetrics : [],
  perfGates,
  reportOnlyMetricIds: [...reportOnly],
});

const jsonPath = resolve(options.outputDir, 'dashboard.json');
const markdownPath = resolve(options.outputDir, 'dashboard.md');
writeFileSync(jsonPath, `${JSON.stringify(dashboard, null, 2)}\n`);
writeFileSync(markdownPath, `${renderMarkdown(dashboard)}\n`);

const completeness = completenessFailures(dashboard, {
  externalStatus,
  requireExternal: options.requireExternal,
  requireAll: options.requireAll,
});
const requiredExternalMissing = completeness.externalMissing;
const missingAbsoluteMetrics = completeness.missingAbsolute;
const requiredAbsoluteMissing = missingAbsoluteMetrics.length > 0;
const skippedMetrics = dashboard.metrics
  .filter((metric) => metric.absoluteStatus === 'skipped')
  .map((metric) => metric.id);
const baselineFailures = options.requireBaseline
  ? baselineRequirementFailures(dashboard.metrics, baseline)
  : [];
const requiredBaselineMissing = baselineFailures.length > 0;
const failed = dashboard.summary.absoluteFail > 0
  || dashboard.summary.relativeFail > 0
  || dashboard.summary.scenarioFail > 0
  || requiredExternalMissing
  || requiredAbsoluteMissing
  || requiredBaselineMissing
  || (options.requireRunner && !runner.matchesExpected);

if (options.json) {
  process.stdout.write(`${JSON.stringify(dashboard, null, 2)}\n`);
} else {
  log(`\ndashboard: ${markdownPath}\nmachine results: ${jsonPath}\n`);
}
if (skippedMetrics.length > 0) {
  const producer = relative(repoRoot, externalPath);
  log(
    `\nStudio metrics SKIPPED (${skippedMetrics.length}): the step that writes ${producer} did not run in this job ` +
      `(outcome: ${options.externalOutcome}), so these rows were not checked. Skipped is neither pass nor fail:\n` +
      `${skippedMetrics.map((id) => `  - ${id}`).join('\n')}\n`,
  );
  if (process.env.GITHUB_ACTIONS === 'true') {
    log(`::warning title=Studio metrics skipped::${skippedMetrics.length} Studio metrics were not checked because the step that writes ${producer} did not run in this job.\n`);
  }
}
if (perfGates === 'report') {
  const over = dashboard.metrics.filter((metric) => metric.absoluteStatus === 'report-only-fail');
  const shown = (value) => (Number.isInteger(value) ? String(value) : value.toFixed(2));
  const rows = over.map((metric) =>
    `${metric.id} = ${shown(metric.value)} ${metric.unit} vs budget ${metric.direction === 'min' ? '≥' : '≤'} ${metric.budget} ${metric.unit}`);
  log(
    `\nperf gates: report (MERIDIAN_PERF_GATES=report). Report-only on this runner: ${[...reportOnly].sort().join(', ')}.\n` +
      `Report-only budgets exceeded (${over.length}): recorded and shown, not enforced; budgets unchanged.\n` +
      `${rows.map((row) => `  - ${row}`).join('\n')}${rows.length > 0 ? '\n' : ''}`,
  );
  if (process.env.GITHUB_ACTIONS === 'true') {
    for (const row of rows) log(`::warning title=Perf budget exceeded (report-only)::${row}\n`);
  }
}
if (process.env.GITHUB_STEP_SUMMARY) {
  // The job summary shows the dashboard even when no artifact is uploaded.
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${renderMarkdown(dashboard)}\n`);
  } catch (error) {
    process.stderr.write(`cannot write job summary: ${error.message}\n`);
  }
}
if (requiredExternalMissing) {
  process.stderr.write(`required Studio external metric set is incomplete or invalid: ${externalPath}\n`);
}
if (requiredAbsoluteMissing) {
  process.stderr.write(`required absolute measurements missing (${missingAbsoluteMetrics.length}):\n${missingAbsoluteMetrics.map((id) => `  - ${id}`).join('\n')}\n`);
}
if (requiredBaselineMissing) {
  process.stderr.write(`required relative baseline failed (${options.baseline}):\n${baselineFailures.map(({ id, status }) => `  - ${id}: ${status}`).join('\n')}\n`);
}
if (options.requireRunner && !runner.matchesExpected) {
  process.stderr.write(`runner mismatch: declared ${runner.declaredClass}, expected ${profile.declaredClass} on ${profile.platform}/${profile.arch} Node ${profile.nodeMajor}\n`);
}
process.exitCode = failed ? 1 : 0;
