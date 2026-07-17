# Performance profiling and benchmark baselines

Meridian treats performance rows as tests. `pnpm bench` (or the built CLI's
`meridian bench`) executes the existing scenario owners, checks absolute
contracts in `benchmarks/budgets.json`, applies the relative-regression rule,
and writes both `benchmarks/results/dashboard.json` and
`benchmarks/results/dashboard.md`. Scenario logs live beside them. The result
directory is generated and uploaded by CI; it is intentionally not committed.

## Reference runner and relative gate

The reference class is
`github-actions-ubuntu-24.04-x64-node-24`: `.github/workflows/ci.yml` pins
`ubuntu-24.04` and Node 24, while `benchmarks/runner.json` pins the class name,
platform, architecture, Node major, and **15%** regression tolerance. CI sets
`MERIDIAN_BENCH_REQUIRE_RUNNER=1`, so a renamed image or accidental Node/arch
change fails instead of silently creating incomparable numbers.

For a ceiling metric, `(candidate − baseline) / baseline > 0.15` fails. For a
floor metric the sign is reversed. Absolute budgets always apply as well. A
new metric without a measured baseline is reported as `not-calibrated`, never
assigned a made-up value. Relative comparison becomes active automatically as
soon as that metric appears in `benchmarks/baseline.json`; a relative failure
always exits non-zero. A local run from another class is reported as
`runner-mismatch` and is checked against absolute budgets only.

The checked-in baseline is deliberately `unmeasured` until reference CI has
produced evidence. To calibrate it:

1. Obtain at least three successful `benchmark-dashboard` artifacts from
   independent runs of the same known commit on the declared runner. Each must contain the Studio
   result and show `matchesExpected: true`.
2. Run:

   ```sh
   node benchmarks/calibrate-baseline.mjs --out /tmp/baseline.json \
     run-1/dashboard.json run-2/dashboard.json run-3/dashboard.json
   ```

3. Review the source run IDs, commits, units, and medians, then replace
   `benchmarks/baseline.json` through normal code review. After every metric is
   calibrated, set `MERIDIAN_BENCH_REQUIRE_BASELINE=1` in CI so a newly missing
   row also fails. Recalibration needs the same evidence and review; it is not
   a way to bless a regression.

## Browser measurement input

Studio Playwright writes `benchmarks/results/studio.json` before the collector
runs. Its minimal schema is:

```json
{
  "schemaVersion": 1,
  "source": "studio-playwright",
  "metrics": [
    {
      "id": "edit-to-pixel-p95-ms",
      "value": 123.4,
      "unit": "ms",
      "sampleCount": 100
    }
  ]
}
```

Local absence is shown as `not-measured`. CI sets
`MERIDIAN_BENCH_REQUIRE_EXTERNAL=1` and `MERIDIAN_BENCH_REQUIRE_ALL=1`, making
an absent, malformed, or missing row a located failure rather than silently
substituting a Node proxy for real pixels. The same external file contains the
measurements produced by the existing renderer, projection, heap, and
transition owners; repeated IDs are conservatively combined (worst ceiling or
worst floor).

## Reproducing and profiling a regression

Start with the smallest owner script shown in the dashboard, run it at least
three times on an idle machine, and retain the command, commit, runner metadata,
and raw log. Do not profile the whole monorepo when one scenario already
reproduces the row.

For Node CPU and allocation work:

```sh
mkdir -p /tmp/meridian-profiles
node --cpu-prof --cpu-prof-dir=/tmp/meridian-profiles benchmarks/abstraction-cut.bench.mjs
node --expose-gc --heap-prof --heap-prof-dir=/tmp/meridian-profiles benchmarks/phase11-scale.bench.mjs
```

Open `.cpuprofile` files in Chromium DevTools' Performance panel and
`.heapprofile` files in its Memory panel. For peak-memory investigation, also
record `process.memoryUsage()` at semantic batch boundaries; avoid forcing GC
inside the timed path unless the budget explicitly measures post-GC retention.

For browser edit-to-pixel or rendering rows, retain the failing Playwright
trace and use Chromium's Performance/Memory panels with the same fixture,
viewport, software-render flags, and interaction script as CI. Separate input,
ChangeSet/cut/layout/render-patch, and presentation timestamps before choosing
a hot path—the end-to-end number alone does not identify one.

Every performance change should attach the before/after dashboard and the
profile that motivated it. A WASM recommendation additionally needs all of
ADR-0040's evidence: a failing or critically trending row, at least 60% of
self-time in an eligible pure kernel, documented JS-level remedies, a 3× spike,
and equivalence coverage. A green number or an unprofiled hunch is no-go.
