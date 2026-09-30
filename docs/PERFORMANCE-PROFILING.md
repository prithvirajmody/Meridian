# Performance profiling and benchmark baselines

Meridian treats performance rows as tests. `pnpm bench` (or the built CLI's
`meridian bench`) executes the existing scenario owners, checks absolute
contracts in `benchmarks/budgets.json`, applies the relative-regression rule,
and writes both `benchmarks/results/dashboard.json` and
`benchmarks/results/dashboard.md`. Scenario logs live beside them. The result
directory is generated and uploaded by CI (kept 7 days), and CI also writes the
dashboard to the job summary; it is intentionally not committed.

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
substituting a Node proxy for real pixels. CI runs Playwright in its own `e2e`
job (inside the pinned Playwright image), passes `studio.json` to the `bench`
job as a job output, and passes the e2e job's result as
`MERIDIAN_BENCH_EXTERNAL_OUTCOME` (or `--external-outcome`). When it is
`skipped` (an earlier job failed, so Playwright never ran), the Studio rows
are reported as `skipped`, which is neither pass nor fail, in the log, the
dashboard and the job summary, and any `studio.json` on disk is ignored as
stale. For any other outcome the Studio rows stay required. Unknown values are
rejected. The same external file contains the measurements produced by the
existing renderer, projection, heap, and transition owners; repeated IDs are
conservatively combined (worst ceiling or worst floor).

## Hosted CI: report-only budgets

`MERIDIAN_PERF_GATES` selects how budgets apply. The default, `enforce`, fails
on any exceeded budget; every local and manual run behaves this way. CI sets
`MERIDIAN_PERF_GATES=report` on its e2e and bench steps, and nowhere else. In
report mode the metrics listed in `benchmarks/runner.json` `reportOnlyMetrics`
are still measured, recorded, and compared with their unchanged budgets. An
exceeded one shows as `over budget (report-only)` in the dashboard and job
summary and raises a `::warning` annotation instead of failing. Every other
budget stays enforced in CI, and a missing measurement still fails: that is a
correctness check, not a budget. A dashboard with report-only rows over budget
cannot calibrate a relative baseline.

The list holds the rows that GitHub-hosted 2-vCPU `ubuntu-24.04` runners
(SwiftShader, with host CPUs that vary from job to job) cannot meet. PR #1
measured there:

| Metric | Budget | Hosted-runner values |
|---|---|---|
| `renderer-frame-p95-ms` | ≤ 18 ms | 77.6–289.5 ms |
| `outline-scroll-min-fps` | ≥ 55 fps | 18.5–27.5 fps |
| `edit-to-pixel-p95-ms` | ≤ 1000 ms | 1090.9–1485 ms |
| `hydrated-navigation-first-fine-cut-ms` | ≤ 1000 ms | 672.9–1109.8 ms, 4 of 7 runs over |

The budgets themselves are unchanged; they only ratchet down. Hosted CI
reports these rows only until a pinned runner or a 4-core runner (for example,
once the repository is public) exists. At that point, remove them from
`reportOnlyMetrics` and drop the variable from `.github/workflows/ci.yml`.

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
