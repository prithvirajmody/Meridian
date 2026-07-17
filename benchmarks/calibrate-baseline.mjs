#!/usr/bin/env node
/** Build a relative baseline from repeated dashboards measured on one pinned
 * runner class. This command never runs a benchmark and never supplies a
 * default value: three real, green run artifacts are mandatory. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { calibrateDashboards } from './lib/calibration.mjs';

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
if (outAt < 0 || args[outAt + 1] === undefined) {
  process.stderr.write('usage: node benchmarks/calibrate-baseline.mjs --out <baseline.json> <dashboard.json> <dashboard.json> <dashboard.json> […]\n');
  process.exit(2);
}
const output = resolve(args[outAt + 1]);
const inputs = args.filter((_, index) => index !== outAt && index !== outAt + 1).map((path) => resolve(path));
if (inputs.length < 3) {
  process.stderr.write('baseline calibration requires at least three independent pinned-runner dashboards\n');
  process.exit(2);
}

function read(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path}: ${error.message}`);
  }
}

try {
  const dashboards = inputs.map(read);
  const profile = read(new URL('./runner.json', import.meta.url));
  const budgets = read(new URL('./budgets.json', import.meta.url));
  const baseline = calibrateDashboards(dashboards, { profile, budgets });
  writeFileSync(output, `${JSON.stringify(baseline, null, 2)}\n`);
  process.stdout.write(`wrote ${Object.keys(baseline.metrics).length} measured baselines from ${dashboards.length} runs to ${output}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
