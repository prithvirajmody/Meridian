# Phase 7 — verification table & gate checklist

ROADMAP Phase 7 §12 walked row by row on 2026-07-12 in the 7H gate session.
Every number below comes from a harness run in this session (none asserted from
memory). Human-judgment rows are marked **UNVERIFIED — HUMAN** with exact
commands; the (Once P6 lands) UI row is **QUEUED** into the combined M2+P7 demo
per SUBPHASES §7H. The phase gate itself (tag `phase-7`) closes per
DRIVING-OPUS.md §4 — the supervisor commits, the user tags.

Subphases committed through 7G (`b55c405`): 7A ADRs 0026–0028, 7B tree-sitter
shim + grammars, 7C TypeScript mapping, 7D Python mapping, 7E import/call graph,
7F CFG + lazy AST (DetailResolver, plugin-api 0.2.0), 7G IncrementalAdapter +
`meridian watch`. 7H (this gate) adds: adapter options (include/exclude globs +
`--lang` allowlist), the pinned OSS scale fixture + summary golden, the
symlink-cycle and >10MB-oversize failure coverage, and the dogfood drill-in.

## Headline numbers (this session, real output)

| Gate | Budget | Measured |
|---|---|---|
| Cold ingest of pinned OSS repo (`vuejs/core`, 489 TS files, ~153k LOC) | < 30 s | **2.79 s** |
| Byte-determinism (two ingests → identical bytes) | identical | **identical** — SHA-256 `43658ad9…d1212` both runs |
| Incremental edit → applied delta (7G) | < 100 ms p95 | **2.07 ms p95** (mean 1.08 ms, 40 edits) |
| Lazy CFG/AST resolve (7F) | < 150 ms p95 | **4.78 ms p95** (mean 2.16 ms, 24 fns; max 5.14 ms) |
| Dogfood drill `scan.ts::collectCalls` → CFG/AST | < 150 ms | **14.1 ms** (6 blocks, 7 flows, AST) |
| Full suite | green | **1045 tests, 13 suites, 0 failures** |
| Benchmarks | all budgets green | **all PASS** (list below) |

## Verification table (ROADMAP Phase 7 §12)

| Category | Result | Evidence |
|---|---|---|
| Unit | **PASS** | `@meridian/adapter-code` → **170 tests** (per-construct mapping rules TS+Py — `mapping.test.ts`, `python-mapping.test.ts`; ID-stability functions incl. overload/duplicate/default discriminators — `id-stability.test.ts`, `python-id-stability.test.ts`; CFG vs hand-drawn truth for early-return/try-finally/loops/switch/match — `cfg.test.ts`; import/call resolution — `edges.test.ts`, `python-edges.test.ts`; byte-determinism — `determinism.test.ts`, `python-determinism.test.ts`; grammar shim — `shim.test.ts`). CLI glob matcher — `apps/cli/test/globs.test.ts` (19). |
| Integration | **PASS** | Per-corpus eager-level graphs (both languages) are pinned as *executable-law* goldens by the conformance kit — `packages/adapters/code/test/conformance.test.ts` drives the plugin over `fixtures/corpora/code-ts` and `code-py` (classes/functions/bindings/overloads/duplicates/namespaces/default-exports/decorators, project→package→module→class/function), asserting gate-clean, deterministic, AI-free, identity-stable ingest; `determinism.test.ts` / `python-determinism.test.ts` byte-pin the output. The **pinned fixture-repo eager-level golden** (compact per-kind node/edge counts across all eager levels + digest) is `fixtures/goldens/oss/vue-core.summary.json` via `apps/cli/test/oss-scale.test.ts`; the module cut of the fixture/dogfood repo is exercised in the dogfood cut table below. Watch-mode edit scripts → minimal deltas through the real store: `apps/cli/test/watch-repo.test.ts` (`--edits`) + `packages/adapters/code/test/incremental-conformance.test.ts` (expected-delta edit scripts). |
| Performance | **PASS** | Cold ingest OSS **2.79 s < 30 s** and byte-deterministic (`oss-scale.test.ts`, logged `[7H]`). Incremental edit→applied delta **2.07 ms p95 < 100 ms** (`incremental.test.ts` `[7G]`). Lazy AST resolve **4.78 ms p95 < 150 ms** (`detail-resolver.test.ts` `[7F]`). Bench budgets all green (below). |
| UI verification (Once P6 lands) | **QUEUED** | Playwright "zoom the fixture repo project→AST; screenshot goldens at module + function levels" is **queued into the combined M2+P7 demo** per SUBPHASES §7H — P6/Studio has not landed on this (domain) track, so there is no renderer to screenshot yet. Not built here (anti-scope). |
| Architecture | **PASS** | `pnpm depcruise` → **no violations (317 modules, 962 deps)**. Core/`abstraction` carry no `code:` domain vocabulary — enforced by `packages/adapters/code/test/architecture.test.ts` (precise kind-regex; the graph-core doc-comment illustration of `'code:function'` is the sole allowed mention). `pnpm audit:strings` clean; `pnpm lint`, `pnpm typecheck` clean. Grammars load only through the worker-hosted shim (`src/shim.ts` via `worker/`, wired by `ParseWorkerHost`; `src` carries no `node:*` — same architecture rule). |
| Manual exploratory | **UNVERIFIED — HUMAN** | Dogfood: `meridian ingest` this monorepo, cuts at every level, drill into a known function. Real artifacts + counts in the **Dogfood report** below; the "reads truthfully" judgment is the supervisor's/user's. |
| Failure cases | **PASS** | Syntax-error files → partial, flagged graph: `packages/adapters/code/test/parse-errors.test.ts` (unit) **and demonstrated live** (dogfood: 10 modules flagged `code:parse-error`, below). Symlink cycle at root → no hang, no duplication: `apps/cli/test/adapter-options.test.ts`. >10 MB file → excluded by ADR-0027 budget, flagged `code:excluded:'oversize'`, cold, non-resolvable, never parsed: same file. Grammar load failure → located error naming language + file: `packages/adapters/code/test/shim.test.ts`. |
| Regression | **PASS** | Full suite **1045 tests / 13 suites / 0 failures** (graph-core 96 · graph-store 85 · plugin-api 6 · plugin-host 26 · conformance-kit 11 · adapter-markdown 27 · adapter-code 170 · abstraction 90 · view-model 19 · layout 94 · renderer 92 · studio 22 · cli 307). All prior CLI/SVG goldens **byte-unchanged** (`git status fixtures/goldens/` shows only the new `oss/` addition). Repo goldens pinned to fixture commit `c0606e91…` (`fixtures/goldens/oss/vue-core.summary.json`). |

### Benchmarks (`pnpm bench`, 2026-07-12)

All PASS: `100k-decode-validate 772.3/1500` · `100k-stats 8.2/200` ·
`store-10k-op-delta 29.4/50` · `store-1k-transactions-100k 128.3/2000` ·
`store-100k-snapshots 2.7/100` · `version-chain-share 99.90%/≥90%` ·
`ingest-5mb-markdown 1317.8/2000` · `abstraction-cut-cold 72.8/150` ·
`abstraction-cut-warm 0.2/30` · `elk-2k-compound 965.7/1500` ·
`elk-incremental-10 64.7/100` · `force-10k-convergence 2348.8/3000` ·
`layout-stability-min 1.000/≥0.90`.

### The pinned OSS scale fixture

- **Repo:** [`vuejs/core`](https://github.com/vuejs/core) @
  `c0606e91798c8dca4f33d101e1dd836d672592c1` — 489 `.ts`/`.tsx` files, ~153k LOC.
- **Not vendored.** Fetched outside the tree by `fixtures/oss/fetch.sh` into the
  gitignored `fixtures/oss/clones/vue-core`. Only the compact summary golden is
  committed (`fixtures/goldens/oss/vue-core.summary.json` — per-kind node/edge
  counts, totals, ADR-0026 `resolutionRate`, and a SHA-256 digest of the
  canonical document; ~30 lines, not a 2.4 MB dump). See `fixtures/oss/README.md`.
- **Regen story:** `fixtures/oss/fetch.sh` then
  `UPDATE_GOLDENS=1 pnpm --filter @meridian/cli test oss-scale` (the repo's
  standard `UPDATE_GOLDENS` convention; never edited by hand).
- **CI:** `oss-scale.test.ts` **skips** when the clone is absent (CI never
  fetches), so the suite stays green everywhere; when present it re-checks
  < 30 s, byte-determinism, and the golden.
- The eager graph is only ~1.9k nodes for ~153k LOC — the ADR-0027 laziness win
  made visible (node count is O(declarations), not O(LOC)).

### Adapter options (ROADMAP §6) — include/exclude globs, `--lang` allowlist

Wired through both `meridian ingest <dir>` and `meridian watch <dir>`. The CLI
is the composition root and owns the filesystem walk (ADR-0009): `--include` /
`--exclude` take comma-separated POSIX globs (`**`, `*`, `?`) over repo-relative
paths, `--lang` a comma-separated allowlist (`typescript`, `python`). Verified
in `apps/cli/test/adapter-options.test.ts` over throwaway temp repos (lang drop,
include restrict, exclude-wins-over-include, composition, unknown-lang usage
error) and demonstrated live on the OSS + dogfood ingests. Filtered files are
never read (clean graph semantics) — see the ADR-0027 note under ADR flags.

## Dogfood report — UNVERIFIED — HUMAN

*"Load this project's own monorepo; navigate to a known function; judge whether
every level reads truthfully."* (ROADMAP §12.) The final judgment is the
supervisor's/user's; below are the real artifacts and counts.

**Ingest** (1.89 s):

```sh
node apps/cli/dist/main.js ingest . \
  --include 'packages/**,apps/**' \
  --exclude '**/dist/**,**/node_modules/**,**/*.d.ts' --out meridian.json
```

→ 305 graphs · **1565 nodes** · **1287 edges** · roots 1 · max depth 9.
By kind: `project 1 · package 55 · module 314 · class 39 · function 826 ·
method 330`; edges `imports 427 · calls 860`.

**Cuts at every level** (`meridian cut meridian.json --level N`):

| level | cut nodes | induced edges | what it shows |
|---|---|---|---|
| 0 | 1 | 0 | the project |
| 1 | 2 | 0 | the two top dirs: `packages`, `apps` |
| 2 | 12 | 0 | package subdirectories |
| 3 | 39 | 16 | packages resolving into modules; **imports 13 / calls 3** |
| 4 | 239 | 344 | modules appear; **imports 289 / calls 55** (structure-dominated) |
| 5 | 739 | 533 | functions/classes appear; **calls 407 / imports 126** (behaviour takes over) |
| 6 | 1046 | 601 | methods appear; calls 538 / imports 63 |
| 7 | 1226 | 711 | calls 679 / imports 32 |
| 8 | 1261 | 759 | finest: every fn/method/class; **calls 727 / imports 32** |

The induced-edge mix shifting from **imports-dominated at coarse levels** to
**calls-dominated at fine levels** is the ADR-0013 aggregation + ADR-0026
import/call story reading correctly: zoomed out you see module structure, zoomed
in you see behaviour. Coverage held at every level (`covers: true`, 1261 leaves).

**Drill into a known function** (`packages/adapters/code/src/map/scan.ts ::
collectCalls`, a real Meridian function) — permanent test
`packages/adapters/code/test/dogfood-drill.test.ts`:

→ cold at ingest (no `detail`, carries `code:body-span` marker); one resolve
materializes **6 CFG basic blocks + 7 `code:flows-to` edges** and the AST
(`code:stmt`/`code:expr`) under them, byte-identical to an eager materialization
(`deriveGraphId` of the fn coords), source-tagged, in **14.1 ms**.

**Things that read falsely / honestly-partial (findings for the human judge):**

- **`.tsx`/JSX partials.** 10 of 314 modules are flagged `code:parse-error`
  (`code:error-count` set) — mostly Studio `.tsx` files (`SelectedPanel.tsx` 42,
  `DebugHud.tsx` 30 recovered errors) plus a few `.ts` with 1 isolated error.
  The vendored TypeScript grammar does not fully cover TSX/JSX, so those files
  ingest **partial-but-flagged** (exactly the failure-case contract, live). Node
  counts above include their recovered declarations. Not a data-loss crash — a
  documented precision gap; a dedicated TSX grammar is a future plugin-sized add.
- **Call resolution is import-dominated** (ADR-0026, expected): dogfood TS
  `resolutionRate = 0.334` (resolved 1554 / unresolved 3095; external 413
  excluded) — most *method* calls (`x.foo()`) are honestly unresolved without a
  type checker. See the ADR flag below.

Reproduce: the ingest + cut commands above (deterministic), and
`pnpm --filter @meridian/adapter-code test dogfood-drill`.

- [ ] **UNVERIFIED — HUMAN:** walk the levels above and the drill-in; confirm
      each cut "reads" like a truthful summary of the one below; eyeball the
      `.tsx` partials and the import-dominated call graph and file anything
      surprising.

## UI verification (zoom the repo) — QUEUED to M2+P7

Per SUBPHASES §7H, the Playwright "zoom project→AST, screenshot goldens at
module + function levels" row lands **in the combined M2+P7 demo**, not here:
the domain track (P7) is headless and P6/Studio has not landed on it. The
headless artifacts that demo will drive — deterministic ingest, cuts at every
level, on-demand CFG/AST — are all green above.

- [ ] **QUEUED — combined M2+P7 demo:** record "zoom real code project→module→
      function→CFG→AST" once P6 lands; screenshot goldens at module + function
      levels. (Not a blocker for the headless Phase 7 gate.)

## Definition of Done (ROADMAP Phase 7 §13; gate rules §5.1)

- [x] Every **automated** verification-table row passes — full suite **1045
      tests / 0 failures**, `pnpm lint`/`typecheck`/`depcruise`/`audit:strings`
      clean, `pnpm bench` all budgets green (rows above), 2026-07-12.
- [x] Pinned real OSS repo (~100k LOC) ingests **< 30 s cold (2.79 s)**,
      **byte-deterministic**; repo goldens pinned to the fixture commit hash.
- [x] Adapter options (include/exclude globs, `--lang` allowlist) wired through
      `ingest`/`watch`; ADR-0027 budget proven (>10 MB → flagged excluded);
      symlink cycles neither hang nor duplicate.
- [x] Dogfood: Meridian ingests its own monorepo end-to-end, cuts at every level,
      one CFG/AST drill-in — real counts reported above.
- [ ] **Manual exploratory (dogfood reads truthfully)** — UNVERIFIED — HUMAN,
      section above.
- [ ] **Combined M2+P7 demo recorded** ("Meridian renders Meridian" / zoom code
      to AST) — QUEUED to when P6 lands (SUBPHASES §7H); the headless half is done.
- [ ] Gate closed: human row verified above, then (user) `git tag phase-7`.
      (DRIVING-OPUS.md §4 — the model proposes done, the user declares done.)
      *ADR flags below folded by the supervisor in the gate commit:* ADR-0026
      floor set to 0.30 from the measured numbers; ADR-0027 thresholds
      confirmed as v1 gates; ADR-0027 exclusion-semantics clarification added.

## ADR flags for the supervisor to fold

1. **ADR-0026 open question 1 — the resolution-rate floor, now with real
   numbers.** The 0.60 floor was an explicit placeholder pending 7H measurement.
   Measured `resolutionRate`: **vue-core (TS) 0.411**, **Meridian dogfood (TS)
   0.334** — both **below 0.60**. The gate is an *AND* (rate < 0.60 **and** a
   reviewer judges the module `code:calls` induced graph unusable); the reviewer
   half is the human dogfood row. The induced call graph is usable at the module
   level (it aggregates well — see the L4–L8 cut table), so the recommendation is
   to **revise the floor down to a defensible v1 value (~0.30)** or restate it as
   "advisory, revisit if module cuts read poorly", rather than open the
   type-aware ADR. Numbers are recorded in the OSS summary golden and the dogfood
   report; supervisor to set the final floor in ADR-0026.
2. **ADR-0027 open question 1 — the numbers, confirmed.** 150 ms / 10 MB / 50k
   LOC / 30 s all hold on this hardware with large margin: lazy resolve p95
   **4.78 ms** (budget 150), cold ingest **2.79 s** (budget 30 s), the >10 MB
   exclusion fires as specified. Recommend **confirming these as v1 gates** —
   optionally tightening the resolve budget, but 150 ms leaves healthy headroom
   for slower hardware and larger bodies. (Open questions 2 and 3 — call-scan cap
   and eviction — unchanged; still deferred/flagged as written.)
3. **Adapter-option exclusion semantics vs ADR-0027's `code:excluded` table.**
   ADR-0027 lists "include/exclude globs (§6)" alongside generated files as
   producing a `code:excluded:'generated'` *ghost node*. This gate implements
   glob/allowlist exclusion as **not-walked** (the file never enters the graph) —
   consistent with the pre-existing `SKIP_DIRS` behaviour (node_modules/.git/dist
   are dropped, not ghost-flagged), and it keeps the graph clean (no thousands of
   ghost nodes for excluded trees). `code:excluded` stays reserved for the
   in-tree-but-unparseable **oversize** (and future generated-sentinel) cases,
   which *do* flag a cold node. Recommend folding this reading into ADR-0027 (a
   one-line clarification: user globs filter the walk; `code:excluded` is for
   budget/size exclusions of walked files).
