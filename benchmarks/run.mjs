#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { cpus, totalmem } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  baselineRequirementFailures,
  buildDashboard,
  parseBudgetOutput,
  parseExternalResult,
  renderMarkdown,
} from './lib/dashboard.mjs';

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
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
}

const budgets = readJson(resolve(benchmarkRoot, 'budgets.json'), 'cannot read budget manifest');
const profile = readJson(resolve(benchmarkRoot, 'runner.json'), 'cannot read runner profile');
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
    env: process.env,
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
if (existsSync(externalPath)) {
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
});

const jsonPath = resolve(options.outputDir, 'dashboard.json');
const markdownPath = resolve(options.outputDir, 'dashboard.md');
writeFileSync(jsonPath, `${JSON.stringify(dashboard, null, 2)}\n`);
writeFileSync(markdownPath, `${renderMarkdown(dashboard)}\n`);

const requiredExternalMissing = options.requireExternal && externalStatus !== 'pass';
const missingAbsoluteMetrics = dashboard.metrics
  .filter((metric) => metric.value === null)
  .map((metric) => metric.id);
const requiredAbsoluteMissing = options.requireAll && missingAbsoluteMetrics.length > 0;
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
