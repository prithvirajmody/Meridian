# Phase 11 demo — scale, persistence, and incremental pixels

This is the runbook for the Phase 11 review. It covers the five claims a
recording must show: cold open, streamed 1M-LOC ingest with progress, live
semantic edit → pixel, persistence recovery/fallback, and the benchmark
dashboard. Recording is a human step and is currently **pending** at
`docs/demos/phase-11.webm`.

The script does not turn local timings into reference evidence. Keep the
review open until the pinned dashboard, calibrated baseline, external-file
session, ADR decisions, and checklist sign-off in
`docs/checklists/phase-11.md` are complete.

## 0. Reproducible setup

Run from the repository root with a clean dependency install:

```sh
pnpm install --frozen-lockfile
pnpm build
```

Record the commit and runtime before collecting evidence:

```sh
git rev-parse HEAD
node --version
pnpm --version
```

The accepted performance runner is declared in `benchmarks/runner.json` as
`github-actions-ubuntu-24.04-x64-node-24`. A developer-machine run is a useful
smoke test, never the number quoted at phase close.

## 1. Stream a literal 1M-LOC source and show progress

First run the scale owner directly:

```sh
pnpm --filter @meridian/adapter-code exec vitest run test/streaming.test.ts
```

The fixture is reviewably pinned in the test: 1,000 files × 1,000 lines and a
SHA-256 of the encoded project bundle. The test compares the streamed store to
the monolithic truth document, bounds each queued envelope, requires repeated
producer drains, and enforces its reviewed heap-delta ceiling. This is the
literal 1M-LOC claim; do not substitute the smaller CLI composition fixture.

Then show the same backpressure contract at its seams:

```sh
pnpm --filter @meridian/graph-store exec vitest run test/stream.test.ts
pnpm --filter @meridian/plugin-host test
pnpm --filter @meridian/cli exec vitest run test/stream-ingest.test.ts
```

Finally show the exact same 1M-line bundle through Studio's dedicated code
worker with responsive, bounded progress and retained-heap measurement:

```sh
pnpm --filter @meridian/studio exec playwright test e2e/code-streaming-ingest.spec.ts --headed
```

The scenario pins the bundle hash, keeps task heartbeats alive, caps the
maximum heartbeat gap at 250 ms, observes the progress element, bounds the
queue at 1,024 ops, and caps retained browser heap growth at 256 MiB. The
separate `streaming-ingest.spec.ts` keeps the generated-Markdown path covered.
For the recording, keep the progress strip and a responsive interaction in the
same shot.

## 2. Cold-open 500k stored nodes to the first cut

Run the isolated real-SQLite composition:

```sh
node --expose-gc benchmarks/phase11-scale.bench.mjs
```

It creates a temporary `.meridian` database with exactly 500,000 stored nodes,
performs a logical cold `openProjectStore`, computes the first covering cut
without full hydration, then hydrates the configured 50-graph working set
under its resident-element policy. It removes the temporary project on exit.
This is a store/LOD benchmark in one process after seeding—not app startup,
rendered first pixels, or a 50k navigation/zoom demonstration.

The console should contain one budget row for each of:

- `store-sqlite-stored-nodes-min`
- `cold-open-first-cut-ms`
- `hydrated-working-set-nodes-min`
- `hydrated-navigation-first-fine-cut-ms`
- `hydrated-navigation-p95-ms`
- `hydrated-navigation-soak-heap-growth-bytes`
- `hydration-eviction-required-reclaim-min-share`

Capture these locally as a smoke log only. The review uses the same rows from
`benchmarks/results/dashboard.json` in a successful pinned-CI artifact. Do not
quote a local cold-open time as the contractual result.

For a small, inspectable durability round-trip alongside the scale scenario:

```sh
PROJECT=/tmp/phase11-demo-$(date +%s).meridian
pnpm meridian open "$PROJECT" \
  --import fixtures/valid/deep-nest.meridian.json
pnpm meridian open "$PROJECT" --json
pnpm meridian open "$PROJECT" \
  --export /tmp/phase11-demo-export.meridian.json
```

Use a fresh project path on every run: import intentionally refuses to
overwrite an existing project.

Narrate the distinction: `.meridian` is SQLite-backed durable state; cold
hydration exposes the root slab and graph shells first, and loads detail graphs
on demand behind the unchanged public GraphStore surface.

## 3. Live semantic edit → canvas pixel

Start Studio in one terminal and open the shown URL in Chromium:

```sh
pnpm dev
```

```text
http://127.0.0.1:5173/?e2e=1&debug=1
```

In the browser console, load a visible document, edit its first node through
the same semantic store path used by the automated benchmark, and inspect the
last pipeline record:

```js
await window.__MERIDIAN_STUDIO__.openText(
  'phase11-live.md',
  '# Phase 11\n\n## Before\n\nA visible node.'
);
const node = window.__MERIDIAN_STUDIO__.state().nodeIds[0];
const before = window.__MERIDIAN_STUDIO__.incrementalTelemetry().length;
window.__MERIDIAN_STUDIO__.mutateNodeLabel(node, 'After — incremental');
await new Promise((resolve, reject) => {
  const deadline = performance.now() + 15_000;
  const poll = () => {
    const records = window.__MERIDIAN_STUDIO__.incrementalTelemetry();
    if (records.length > before && records.at(-1)?.editToPixelMs !== null) {
      resolve();
    } else if (performance.now() > deadline) {
      reject(new Error('edit-to-pixel telemetry timed out'));
    } else {
      requestAnimationFrame(poll);
    }
  };
  poll();
});
const record = window.__MERIDIAN_STUDIO__.incrementalTelemetry().at(-1);
({ before, after: window.__MERIDIAN_STUDIO__.incrementalTelemetry().length, record });
```

The label should change on canvas without rebuilding unrelated topology. The
record exposes the ChangeSet summary, affected-cut diff, layout patch, render
patch, model-ready time, and first presented-pixel time. For the automated
browser measurement and dashboard input, run:

```sh
MERIDIAN_PHASE11_BENCH=1 \
  pnpm --filter @meridian/studio exec playwright test e2e/phase11-benchmark.spec.ts
```

That gated scenario opens a 25,000-section working set, performs 24 semantic
label edits, waits for canvas presentation after each edit, checks the p95
absolute budget, and writes `benchmarks/results/studio.json`.

### Boundary that remains open

The console action above is a live **semantic store edit**, not an operating-
system file edit. The Roadmap's manual row explicitly requires editing source
files externally during a full monorepo session. `meridian watch <repo>` proves
the adapter's external-file → delta side, while the Studio benchmark proves
delta → pixels; the review must demonstrate their composition (or amend the
contract) before marking the external-file acceptance item complete.

## 4. Recovery, corruption, disk-full, and browser fallback

Run the Node persistence failure matrix:

```sh
pnpm --filter @meridian/store-sqlite exec vitest run \
  test/crash.test.ts \
  test/persistence.test.ts \
  test/corruption.test.ts \
  test/browser-wasm.test.ts
pnpm --filter @meridian/cli exec vitest run \
  test/open.test.ts test/stream-crash.test.ts
```

The recording or review narration should point to the distinct contracts:

- one child is killed during repeated durable writes and another during
  `stageDeltaStream` over the real SQLite backend; each reopen yields an exact
  committed prefix and a second reopen replays nothing;
- deterministic SQLite quota exhaustion is located as storage I/O failure and
  the in-memory session remains usable;
- corrupt/non-project files refuse rather than half-open, while salvage remains
  an explicit best-effort read path;
- browser quota and single-writer failures remain typed.

Then run the real-browser parity/fallback pair:

```sh
pnpm --filter @meridian/studio exec playwright test e2e/storage-parity.spec.ts --headed
```

One scenario runs the shared protocol over the dedicated
`@sqlite.org/sqlite-wasm` OPFS worker. The other forces OPFS unavailable and
shows a usable in-memory session with document export. Fallback is a durability
degradation, not a correctness failure.

## 5. Produce and read the dashboard

Run the full Studio producer set before the collector. Global setup removes a
stale `studio.json`; the full suite then repopulates every browser-owned metric,
including edit-to-pixel:

```sh
MERIDIAN_PHASE11_BENCH=1 pnpm test:e2e
MERIDIAN_BENCH_REQUIRE_EXTERNAL=1 MERIDIAN_BENCH_REQUIRE_ALL=1 pnpm bench
```

The single `phase11-benchmark.spec.ts` command in §3 produces only the edit-to-
pixel row and is therefore insufficient for a complete dashboard.

The built CLI reaches the same repository runner:

```sh
pnpm meridian bench
```

Inspect:

```text
benchmarks/results/dashboard.md
benchmarks/results/dashboard.json
benchmarks/results/studio.json
benchmarks/results/<scenario>.log
```

The Markdown is the human review surface; JSON is the versioned machine
record. Check the run ID/commit, runner metadata, every absolute status,
relative status, scenario exits, metric sources, and sample counts. A local
runner mismatch, missing Studio JSON, missing absolute row, failed scenario,
or `not-calibrated` relative row keeps the phase open.

CI performs the authoritative run with runner, external-result, and complete-
measurement requirements enabled, then uploads `benchmark-dashboard`. After
at least three independent green pinned artifacts exist, calibrate a candidate
baseline outside the tree:

```sh
node benchmarks/calibrate-baseline.mjs --out /tmp/baseline.json \
  run-1/dashboard.json run-2/dashboard.json run-3/dashboard.json
```

Review run IDs, commits, units, and medians before replacing
`benchmarks/baseline.json` through ordinary code review. Then enable the CI
require-baseline flag. Only that makes the promised ±15% relative rule a
complete gate for every measured row.

The collector owns every roadmap number, including ingest throughput and the
50k hydration/navigation/post-GC-soak/eviction scenario. CI attempts the
benchmark after any post-install failure and always uploads the artifact. The
local 2026-07-16 smoke passed 39/39 absolute rows across 12 scenarios; it is
still not a substitute for the declared runner or calibrated relative gate.

## 6. Human working session and recording shot list

Use a real monorepo, not a synthetic-only corpus, for one uninterrupted
session. Record:

1. cold open to the first useful cut;
2. background streamed ingest with visible progress and responsive UI;
3. navigation through the 50k working set, including drill-in hydration and
   eviction pressure;
4. an external source-file save reaching the rendered map, repeated enough to
   make jank visible if present;
5. crash/reopen plus OPFS-unavailable fallback;
6. the accepted pinned dashboard, including absolute and relative columns.

Write down the fixture, commit, browser, runner, dashboard run ID, and any jank
in `docs/checklists/phase-11.md`. Save the reviewed recording as
`docs/demos/phase-11.webm` (or record the agreed replacement path there).

## Close

Do not cut `phase-11` from this script alone. Close only when the checklist has
retained green pinned artifacts, the external-file session and recording are
reviewed, ADR-0038/0039 are accepted, ADR-0040 is decided from the accepted
measurements/profile, the baseline is calibrated and required, and the final
regression matrix is green.
