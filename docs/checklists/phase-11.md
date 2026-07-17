# Phase 11 — verification table & gate checklist

Phase 11's implementation and local automated gate were completed on
**2026-07-16** from the current working tree. The results below are from
commands actually run that day on Linux x64 / Node 24.15.0. This document
deliberately separates those green local owners from the pinned-runner,
three-run baseline, ADR, manual-session, recording, and tag evidence that only
the external phase review can close.

This document does **not** close Phase 11. Per `DRIVING-OPUS.md`, the user owns
the phase review, ADR acceptance/decision, recording, and `phase-11` tag.

## Gate state

| Signal | State | Command | Evidence produced or inspected |
|---|---|---|---|
| Node persistence + hydration | **PASS — LOCAL: 47/47 + 120/120; API Extractor green** | `pnpm --filter @meridian/store-sqlite test && pnpm --filter @meridian/graph-store test` | 8 storage files; 13 graph-store files; hydration/eviction/streaming suites; API report `packages/graph-store/etc/graph-store.api.md` |
| Literal 1M-LOC adapter stream | **PASS — LOCAL: 1/1** | `pnpm --filter @meridian/adapter-code exec vitest run test/streaming.test.ts` | `packages/adapters/code/test/streaming.test.ts` pins 1,000 files × 1,000 lines, its bundle hash, bounded op buffering, heap ceiling, and canonical equivalence |
| Host/store/CLI streaming + crash | **PASS — LOCAL TARGETED** | `pnpm --filter @meridian/graph-store exec vitest run test/stream.test.ts`; `pnpm --filter @meridian/plugin-host test`; `pnpm --filter @meridian/cli exec vitest run test/stream-ingest.test.ts test/stream-crash.test.ts` | graph-store stream 6/6; plugin-host 34/34; CLI streaming/crash 4/4; cancellation reaches parsers/workers; no partial publication; exact durable prefix after SIGKILL |
| Incremental cut → layout → render path | **PASS — LOCAL** | `pnpm --filter @meridian/view-model test`; `pnpm --filter @meridian/renderer test`; `pnpm --filter @meridian/studio test` | view-model 34/34; renderer 112/112; Studio 97/97. The fast-check oracle mixes label edits with structural commits that change cut membership/induced edges, then matches cold LOD/layout/render. |
| Browser parity + streamed progress | **PASS — LOCAL FULL MATRIX** | `MERIDIAN_PHASE11_BENCH=1 pnpm test:e2e` | 63/63: OPFS parity/fallback, generated progress, and the exact hash-pinned 1M-line code-worker path with visible bounded progress, heartbeat-gap, and retained-heap assertions |
| Edit-to-pixel measurement | **PASS — LOCAL; PINNED RUN PENDING** | `MERIDIAN_PHASE11_BENCH=1 pnpm --filter @meridian/studio exec playwright test e2e/phase11-benchmark.spec.ts` | 24 samples over 25,000 sections: **891.2 ms p95** locally; the accepted value must come from the pinned dashboard |
| 500k storage / 50k working set / cold open | **PASS — LOCAL; PINNED RUN PENDING** | `node --expose-gc benchmarks/phase11-scale.bench.mjs` | 500,000 stored; 50,450 resident; cold cut 165.0 ms; first fine cut 732.8 ms; navigation p95 0.2 ms; retained growth 11,739,888 bytes; reclaim share 1.0 |
| Full benchmark dashboard | **PASS — LOCAL OWNERS; PINNED CI PENDING** | `MERIDIAN_PHASE11_BENCH=1 pnpm test:e2e`, then `MERIDIAN_BENCH_REQUIRE_EXTERNAL=1 MERIDIAN_BENCH_REQUIRE_ALL=1 pnpm bench` | 39/39 absolute rows and 12/12 scenarios pass locally; every Phase 11 owner is registered. Relative results correctly report runner mismatch until pinned evidence exists. |
| Relative-regression baseline | **NOT CALIBRATED** | `node benchmarks/calibrate-baseline.mjs --out /tmp/baseline.json run-1/dashboard.json run-2/dashboard.json run-3/dashboard.json` | `benchmarks/baseline.json` intentionally has `status: "unmeasured"`; three independent green pinned dashboards are required before review |
| Full regression | **PASS — LOCAL; PINNED CI PENDING** | `pnpm lint`; `pnpm typecheck`; `pnpm depcruise`; `pnpm audit:strings`; `pnpm build`; `pnpm test`; `pnpm test:evals`; browser/collector commands above | lint/typecheck/build green; depcruise 619 modules/1,420 dependencies; unit/property/golden 40/40 tasks; evals 1/1; Playwright 63/63; benchmark tests 11/11; dashboard 39/39 |

`benchmarks/results/` is generated output. A partial or sandbox-failed local
collector run is diagnostic only; it is not Phase 11 evidence. In particular,
no local timing is a substitute for the declared
`github-actions-ubuntu-24.04-x64-node-24` runner.

## Subphase implementation ledger

| Subphase | Implementation state | Concrete evidence | Remaining exit evidence |
|---|---|---|---|
| 11A — ADR beat | **Drafted** | `docs/adr/0038-sqlite-embedded-store.md`, `0039-hydration-eviction-policy.md`, `0040-wasm-go-no-go.md` | ADRs remain Proposed; ADR-0040 must be decided from accepted benchmark/profile data, not from code presence |
| 11B — Node backend | **Implemented; local gate green** | `packages/store-sqlite/src/node/`; storage 47/47; stale-writer/single-writer/SIGKILL coverage; `.meridian` CLI coverage joins the full 353-test CLI suite | Pinned CI rerun |
| 11C — hydration/eviction | **Implemented; package gate green** | `packages/graph-store/src/hydration.ts`; no-await history protection, pre-load LRU, correctness-over-budget, byte-identical rehydration; graph-store 120/120 + API Extractor | Pinned dashboard evidence |
| 11D — browser backend | **Implemented; local gate green** | actual SQLite-WASM smoke in `browser-wasm.test.ts`; Node parity in storage 47/47; local Playwright OPFS parity/fallback 2/2 | Full pinned-browser regression |
| 11E — streamed ingestion | **Implemented; local contract green** | bounded staging/backpressure/cancellation; literal 1M-line Node + Studio worker scenarios; 59,146 nodes/s local dashboard; SIGKILL/quota/ENOSPC containment | Retain the same evidence on the declared runner |
| 11F — incremental pipeline | **Implemented; local contract green** | cut/layout/render patches; timed 100 edits/s; hard-cap coalescing; label + structural full-pipeline cold oracle; 891.2 ms local edit→pixel p95 | Manual operating-system file→Studio session and pinned p95 |
| 11G — benchmark gate | **Harness and owners complete; phase gate open** | 39 metrics, 12 scenarios, strict units/provenance/calibrator, pinned CI job, always-attempted post-install dashboard, profiling guide, full local regression | Obtain three green same-commit pinned dashboards, calibrate/activate baseline, review ADRs, run/record human demo, and tag |

## Verification table (ROADMAP Phase 11 §12)

| Category | Result | Evidence and exact gate command |
|---|---|---|
| Unit | **PASS — LOCAL FULL** | `pnpm --filter @meridian/store-sqlite test` → 47/47; `pnpm --filter @meridian/graph-store test` → 120/120 + API Extractor. This covers CRUD/schema/migration/log replay/capabilities, hydration/eviction/undo protection, and bounded stream staging. |
| Integration | **PASS — LOCAL; EXTERNAL-FILE SESSION/PINNED RUN PENDING** | Cold store→cut, exact-prefix SIGKILL recovery, Node/browser parity, full label/structural pipeline convergence, and semantic edit→pixel all pass. The manual operating-system source-file→Studio composition remains external. |
| Performance | **PASS — LOCAL OWNERS; PINNED/RELATIVE GATES PENDING** | All 39 absolute rows pass locally, including stream throughput, cold/fine cut, 50,450-node hydration/navigation/post-GC soak, eviction reclaim, and edit→pixel. The 50k scenario is semantic/hydration scale—not a claim that 50k nodes are simultaneously painted. Relative ±15% remains uncalibrated while `baseline.json` is `unmeasured`. |
| UI verification | **PASS — LOCAL** | `code-streaming-ingest.spec.ts` uses the exact hash-pinned 1M-line bundle through the dedicated code worker and asserts visible progress, ≤1,024 queued ops, repeated task heartbeats, <250 ms max gap, and ≤256 MiB retained growth. The generated-Markdown path independently passes. |
| Architecture | **PASS — LOCAL** | `pnpm depcruise` → no violations across 619 modules / 1,420 dependencies; API Extractor green. SQLite imports remain confined to `store-sqlite`; tree-sitter runtime/grammar sources are absent from Studio's main source map and live in the code worker chunk. |
| Manual exploratory | **UNVERIFIED — HUMAN** | Work for a full session on a real monorepo: cold open, navigate/zoom, edit source files externally, and watch the rendered map. Record fixture/commit/runner and jank notes in this checklist. The in-app `mutateNodeLabel` benchmark is useful automation but is not this row. |
| Failure cases | **PASS — LOCAL** | Storage 47/47 covers full/corrupt/salvage/quota/SIGKILL/single-writer/stale-writer; CLI covers streamed SIGKILL and ENOSPC; browser parity/fallback passes; Studio covers sustained 100 edits/s, rejection, hard-cap compaction, superseded-ingest cancellation, and spatial-index races. |
| Regression | **PASS — LOCAL; PINNED CI PENDING** | Full prior corpus and SQLite parity join the 40/40-task root suite; Playwright 63/63; eval 1/1; benchmark owners 39/39. |

## Acceptance criteria (ROADMAP Phase 11 §11)

- [ ] The pinned literal ~1M-LOC fixture ingests through the streaming path with
  the reviewed heap ceiling, bounded op queue, and visible responsive progress
  on the declared reference runner. The exact composed Node/Studio scenarios
  are green locally; retained pinned evidence is the remaining condition.
- [ ] A 500k-node `.meridian` project reaches its first interactive covering cut
  from cold in **<3 s** on the declared runner; the value is present in the
  retained dashboard artifact.
- [ ] The 50k-node working set navigates/zooms within all renderer, transition,
  heap-soak, and hydration budgets in the same accepted run.
- [ ] External source-file edit → rendered pixels is **<1 s p95**. The current
  Playwright producer measures semantic store edit → pixels; complete the
  external-file composition or explicitly amend the contract before checking
  this item.
- [x] Supporting convergence layers are automated: 100 shuffled commuting
  edge-add ChangeSets equal from-scratch induced aggregation for a fixed cut,
  arbitrary queues preserve every edit in order, and a 100-edit Studio batch
  lands on the final label/model revision.
- [x] Generated rapid label/structural interleavings (real op-based grouping
  commits that change cut membership and induced edges) produce the same LOD,
  positions, routes, bounds, and RenderModel as cold recomputation.
- [x] `kill -9` during `stageDeltaStream` over the real SQLite backend, then
  reopen, recovers an exact committed prefix; a second reopen replays zero
  deltas (`apps/cli/test/stream-crash.test.ts`, 2/2 locally).
- [ ] Every numeric entry in `benchmarks/budgets.json` is measured and green in
  the pinned dashboard; the reviewed three-run baseline is calibrated and the
  ±15% relative gate is active.

## Definition of Done (ROADMAP Phase 11 §13)

- [x] Dashboard collector, machine/Markdown outputs, scenario logs, local
  `meridian bench` composition root, and CI artifact upload are implemented.
- [x] Every Phase 11 performance promise has a versioned budget, expected unit,
  and scenario owner, including ingest throughput and 50k hydration/navigation/
  soak/eviction.
- [x] After a successful install, the dashboard is attempted even if an earlier
  CI gate fails; its artifact upload remains `if: always()`.
- [x] The runner profile and non-invented baseline policy are versioned; the
  profiling/calibration procedure is documented in
  `docs/PERFORMANCE-PROFILING.md`.
- [ ] At least one complete green `benchmark-dashboard` artifact exists from
  the declared pinned runner with the Studio external result included.
- [ ] At least three independent green pinned runs have been reviewed and used
  to calibrate `benchmarks/baseline.json`; CI requires the calibrated baseline.
- [ ] ADR-0038 and ADR-0039 accepted by the user; ADR-0040 decided from retained
  Phase 11 measurements and profiles. This checklist does not change ADR status.
- [ ] Manual monorepo session completed with external edits and jank notes.
- [x] Full-pipeline label/structural arbitrary-interleaving convergence is
  property-tested against cold cut/layout/render recomputation.
- [ ] Demo in `docs/demos/phase-11.md` run and recording saved as
  `docs/demos/phase-11.webm` (or the reviewed equivalent).
- [x] Full local automated regression matrix passes against the final tree.
- [ ] External verification rows (pinned dashboards/baseline, manual session,
  ADR review, and recording) pass at phase review.
- [ ] Phase gate closed by the user and `phase-11` tag cut.

## Evidence record to fill at the review

| Evidence | Run/commit | Runner | Result or artifact |
|---|---|---|---|
| Targeted Node/package gates | uncommitted tree, 2026-07-16 | local Linux x64 / Node 24.15.0 | counts recorded in Gate state; all listed targeted commands green |
| Targeted browser parity/progress | uncommitted tree, 2026-07-16 | local Chromium software | 4/4 |
| Final root regression | uncommitted tree, 2026-07-16 | local Linux x64 / Node 24.15.0 | 40/40 tasks; eval 1/1 |
| Complete local browser/dashboard | uncommitted tree, 2026-07-16 | local Chromium software | Playwright 63/63; 39/39 absolute rows, 12/12 scenarios |
| Green dashboard run 1 | _pending_ | `github-actions-ubuntu-24.04-x64-node-24` | _pending_ |
| Green dashboard run 2 | _pending_ | `github-actions-ubuntu-24.04-x64-node-24` | _pending_ |
| Green dashboard run 3 | _pending_ | `github-actions-ubuntu-24.04-x64-node-24` | _pending_ |
| Baseline review | _pending_ | pinned runner | _pending_ |
| Manual monorepo session | _pending_ | _pending_ | _pending_ |
| Demo recording | _pending_ | _pending_ | `docs/demos/phase-11.webm` |
