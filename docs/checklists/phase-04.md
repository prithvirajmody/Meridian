# Phase 4 — verification table & gate checklist

ROADMAP Phase 4 §12 walked row by row on 2026-07-11, every harness run for
real this session (all numbers below are from this walk, not asserted from
memory). Human-judgment rows are explicitly marked **UNVERIFIED — HUMAN** with
the exact commands/files to run; the phase gate itself (tag `phase-4`) is
closed by the supervisor, not the model (DRIVING-OPUS.md §4).

This is the 4E gate. Subphases 4A–4D are committed
(`f2b5f77`, `9c845b2`, `5d2897a`, `58298db`); 4E adds the seeded `d3-force`
provider, the ADR-0018 default-provider heuristic, force corpus goldens, and
this gate prep.

## Verification table (ROADMAP Phase 4 §12)

| Category | Result | Evidence |
|---|---|---|
| Unit | **PASS** | `@meridian/layout` → 11 files, **93 tests**, 0 failures (providers-vs-truth, `choose-provider` per-rule, `d3-force` determinism/stability/cancellation, cache keying, stability scorer, hint plumbing) |
| Integration | **PASS** | CLI suite → 6 files, **275 tests**, 0 failures incl. **84 layout SVG goldens** (grid/tree/elk-layered/d3-force × corpus × every level) + the same 84 re-checked byte-identical **in the worker** |
| Performance | **PASS** | elk 2k-compound 848.6 ms (≤1500) · elk incremental-10-node 61.1 ms (≤100) · **force 10k-convergence 1952.6 ms (≤3000)** · stability floor **1.000 (≥0.90)** · main-thread boundary maxDispatch 1.415 ms / maxHandle 0.030 ms, liveness maxGap 1.829 ms (all ≤4 ms) |
| UI verification | **UNVERIFIED — HUMAN** | SVG snapshots reviewed against the checklist (overlap %, label room, symmetry). Commands + files below |
| Architecture | **PASS** | `pnpm depcruise` → no violations (167 modules, 496 deps); `pnpm audit:strings` clean; d3-force added to the layout engine-dep allowlist alongside comlink/elkjs |
| Manual exploratory | **UNVERIFIED — HUMAN** | Ugliest-fixture exploratory (pathological-nesting deep, no-headings, empty) across all four providers. Pathology notes + golden paths below |
| Failure cases | **PASS** | provider crash → grid fallback; cancellation actually stops compute; cancellation storm; zero-size nodes; disconnected components — all automated & green (details below) |
| Regression | **PASS** | full uncached suite: **18 turbo test tasks, 707 tests, 0 failures**; grid/tree/elk goldens **byte-unchanged** (git: 0 modified, 21 new `d3-force` goldens only) |

### Unit — providers vs truth, the heuristic, force determinism/stability

`pnpm --filter @meridian/layout test` → **11 files, 93 tests, all passing**
(uncached, 2026-07-11). Row items map to:

- providers on tiny graphs vs hand-computed truth — `test/providers.test.ts`.
- **`chooseProvider` (ADR-0018) each rule** — `test/choose-provider.test.ts`
  (11): V≤1→grid, E==0→grid, forest→tree, DAG-ish→elk-layered,
  cluster-ish-by-`C`→d3-force, dense→d3-force, messy-middle→d3-force,
  determinism, the ADR constants, and the `V_MAX` cost guard (fast + correct
  above the bound; the `C≥γ` disjunct provably never changes the result because
  rules 5 and 6 both return d3-force).
- **`d3-force` (4E)** — `test/d3-force.test.ts` (11): **seeded determinism**
  (same input → byte-identical positions; each seed reproducible and generally
  distinct from another), **warm-start stability ≥0.90** on a scripted
  small-delta sequence (score equals an independent recompute — no self-lie),
  **cooperative cancellation** (pre-aborted and mid-run → AbortError), and
  totality (empty/single/disconnected/zero-size all finite; no edgeRoutes).
- cache keying / hint plumbing — `test/cache.test.ts`, `test/stability.test.ts`.

### Integration — `meridian layout --svg` goldens for all four providers

- `apps/cli/test/layout-golden.test.ts` — **84 golden cases** plus the
  worker-parity re-check and the contract tests, all passing. The six markdown
  corpus documents (`basic`, `links`, `commonmark-edges`,
  `pathological-nesting`, `no-headings`, `empty`) are ingested through the real
  CLI pipeline and laid out at **every** level with **grid, tree, elk-layered,
  and d3-force** — end-to-end ingest → cut → layout → SVG. Goldens live in
  `fixtures/goldens/cli/layout.*` and regenerate **only** via
  `pnpm goldens:update` (never by hand).
- The **worker suite** re-runs every case with `--worker` and asserts the SVG
  is byte-identical to the committed golden — proving grid/tree/elk **and
  d3-force** produce identical geometry in the ADR-0017 Comlink worker as on the
  main thread (d3-force computes purely on member indices/sizes/edges/seed, so
  placeholder ids reproduce the geometry exactly).
- **The ADR-0018 default heuristic on real cuts** (no `--provider`): it
  genuinely selects three of the four engines across the corpus —
  `commonmark-edges` L0 (7 nodes, 1 edge, a forest) → **tree**; `links` L1
  (4 nodes, 5 edges, cyclic) → **d3-force**; the many edgeless containment cuts
  → **grid** (E==0, rule 2); L0 single-node cuts → **grid** (rule 1). The
  output reports `providerDefaulted: true` in `--json`.

### Performance — force convergence, stability, elk budgets, 4ms boundary

`node benchmarks/layout-force.bench.mjs` (also in `pnpm bench` / `pnpm run ci`),
2026-07-11, on this machine:

- `10k-node force: 10000 members, 13332 edges` →
  **PASS layout-force-10k-convergence-ms 1952.6 ms (budget ≤ 3000 ms)** (median
  of 3; all positions finite and complete). Large cuts (`N > 2000`) use a
  bounded-budget mode — looser Barnes–Hut `theta`, no collision force, tick cap
  60 — to hold the budget; small corpus cuts keep the accurate settings.
- `stability scores (8-node deltas): 1.000 …` →
  **PASS layout-stability-small-delta-min 1.000 (budget ≥ 0.90)** — d3-force
  holds persistent nodes through the warm relaxation (see ADR flag below).

`node benchmarks/layout-elk.bench.mjs` (4D, re-run this session, unchanged):
**PASS layout-elk-2k-compound-ms 848.6 ms (≤1500)**,
**PASS layout-elk-incremental-10-node-delta-ms 61.1 ms (≤100)**,
**PASS layout-stability-small-delta-min 1.000 (≥0.90)**.

Main-thread-never-blocked->4ms — `packages/layout/test/worker-host.test.ts`
(2026-07-11): `4ms boundary (N=20000): maxDispatch=1.415ms, maxHandle=0.030ms;
main-thread grid would block 80.5ms`; `liveness: 90 main-thread samples during
worker compute, maxGap=1.829ms`.

### Architecture — layout imports abstraction/graph-core types + engine deps only

- `pnpm depcruise` → `✔ no dependency violations found (167 modules, 496
  dependencies cruised)`. The `layout-only-abstraction-and-core` rule was
  extended this session to allow **d3-force** (the seeded force engine)
  alongside comlink and elkjs — all three isomorphic pure JS; `node:*` never
  appears in `layout/src` (only in the CLI/test worker shims).
- `pnpm audit:strings` → clean (no domain vocabulary in core packages,
  including `layout/src`).
- `pnpm lint` and `pnpm typecheck` → clean.

### Failure cases — crash→grid, cancellation, storm, degenerate inputs

All automated and green:

- provider crash inside worker → host recovers, falls back to grid, respawns —
  `test/worker-host.test.ts`: `crash: recovered via main-fallback (grid),
  respawns=1, then back to worker`.
- cancellation actually stops compute (measured) — `cancel: ticks@abort=22,
  ticks+200ms=22, delta=0`; new-request-aborts-stale `supersede: … delta=0`;
  storm `40 superseded → 40 AbortError, 1 survivor, crashes=0`.
- **d3-force cooperative cancellation** — `test/d3-force.test.ts`: pre-aborted
  and mid-tick-loop aborts both reject `AbortError` (the tick loop yields a
  macrotask when a signal is present so the ADR-0017 control-port cancel can be
  delivered).
- zero-size nodes / disconnected components — `test/providers.test.ts` and
  `test/d3-force.test.ts` (finite positions, degenerate point-rects).

### Regression — full suite; grid/tree/elk goldens byte-unchanged

- Full monorepo suite (`pnpm test`), 2026-07-11: **18 turbo test tasks, 707
  tests, 0 failures** — graph-core 96 · graph-store 85 · plugin-api 4 ·
  plugin-host 26 · conformance-kit 11 · adapter-markdown 27 · abstraction 90 ·
  layout 93 · cli 275.
- `pnpm run ci` (lint → typecheck → depcruise → audit:strings → build → test →
  bench) — **green end to end, exit 0**; every budget in
  `benchmarks/budgets.json` PASS (decode 680.9/1500, stats 7.7/200, store-delta
  30.2/50, transactions 129.9/2000, snapshot 2.5/100, version-chain share
  99.90%/≥90%, ingest-5MB 1248.2/2000, cut cold 56.3/150, cut warm 0.2/30,
  elk-2k 848.6/1500, elk-incremental 61.1/100, **force-10k 1952.6/3000**,
  **stability-min 1.000/≥0.90**).
- 21 new `layout.md.*.d3-force.*.svg` goldens added; the grid/tree/elk-layered
  goldens are **byte-unchanged** — `git status fixtures/goldens/cli/` shows only
  additions (0 modified).

## UI verification — UNVERIFIED — HUMAN

*"SVG snapshots reviewed by a human against the checklist (overlap %, label
room, symmetry)."* (ROADMAP §12.) The goldens are the review artifacts; judging
"looks right" is yours. The mechanical walk:

```sh
pnpm build
# regenerate/refresh the working SVGs (idempotent; must leave goldens unchanged):
pnpm goldens:update && git status fixtures/goldens/cli/   # expect: only d3-force additions
# open any golden to judge; e.g. the force layouts (organic) vs elk (layered):
#   fixtures/goldens/cli/layout.md.links.d3-force.l1.svg      (4 nodes, 5 edges — a real graph)
#   fixtures/goldens/cli/layout.md.commonmark-edges.elk-layered.l0.svg
#   fixtures/goldens/cli/layout.md.commonmark-edges.tree.l0.svg
# and re-render any cut live at a chosen provider:
node apps/cli/dist/main.js layout fixtures/.cut-inputs/links.meridian.json \
  --svg /tmp/links.d3-force.l1.svg --provider d3-force --level 1
```

- [ ] **UNVERIFIED — HUMAN:** judge overlap %, label room, and symmetry on the
      four providers' goldens; confirm force reads as organic/clustered, elk as
      layered, tree as hierarchical, grid as packed. If tuning is wanted, the
      ADR-0018 thresholds (`β/δ/γ`) and the ADR-0016 floor are the knobs (both
      frozen as *mechanism*, re-tunable here per the ADR-0012 pattern).

## Manual exploratory (pathology notes) — UNVERIFIED — HUMAN

*"Layout the ugliest corpus fixtures; note pathologies into the tracker with
SVGs attached."* (ROADMAP §12.) Ran **pathological-nesting (deep levels),
no-headings, empty** through **all four providers** this session
(`node apps/cli/dist/main.js layout … --provider <p> --level <n> --json`).
Observed geometry (nodes/edges/bounds/stability), with golden paths as evidence:

**`pathological-nesting` @ level 6** (`maxLevel=6`; the cut is 3 members, **0
induced edges** — a disconnected soup):
- grid → `240×132`, tree → `240×132` (both pack tidily) —
  `fixtures/goldens/cli/layout.md.pathological-nesting.{grid,tree}.l6.svg`
- elk-layered → `782×28` (stretches the edgeless nodes into one wide row) —
  `…pathological-nesting.elk-layered.l6.svg`
- d3-force → `485×316` (charge repulsion spreads the 3 unconnected nodes into a
  loose triangle) — `…pathological-nesting.d3-force.l6.svg`

**`no-headings` @ level 0** (3 members, 0 edges): identical pattern — grid/tree
`240×132`; elk `683×28`; d3-force `495×320`.
Goldens: `fixtures/goldens/cli/layout.md.no-headings.{grid,tree,elk-layered,d3-force}.l0.svg`.

**`empty` @ level 0** (0 members): all four providers → empty `0×0` bounds,
stability 1 (totality holds; no crash) —
`fixtures/goldens/cli/layout.md.empty.{grid,tree,d3-force}.l0.svg` (grid/tree/force;
elk emits the same empty result).

**Pathology observed (the headline):** the markdown corpus at cut levels is
almost entirely **edgeless containment soup** — sibling members at a cut level
have no induced edges between them — so the two graph engines are asked to lay
out unconnected nodes: **elk stretches them into a wide single row** and
**d3-force repels them into a shapeless blob**, both *worse* than grid's packing.
This is exactly why ADR-0018 routes `E == 0` cuts to **grid** (rule 2) and
single-node cuts to grid (rule 1) — the default heuristic never sends these
degenerate shapes to the graph engines. The graph engines are exercised for
real only where induced edges exist (e.g. `links` L1, `commonmark-edges` L0),
which the goldens cover. No crashes, non-finite coordinates, or non-determinism
were observed on any fixture × provider.

- [ ] **UNVERIFIED — HUMAN:** eyeball the above SVGs and confirm the pathologies
      read as described; file anything surprising. (A richer graph-shaped corpus
      arrives with the Phase 7 code adapter, where induced import/call edges make
      elk/force the natural picks.)

## Definition of Done (ROADMAP Phase 4 §13; gate rules §5.1)

- [x] Every automated verification-table row passes in CI — `pnpm run ci` green
      (exit 0), 2026-07-11 (rows above); **707 tests, 18 turbo test tasks**, all
      budgets in `benchmarks/budgets.json` PASS.
- [x] A reviewer can judge layout quality for any fixture **from CI artifacts
      alone** — 84 normalized SVG goldens under `fixtures/goldens/cli/`
      (grid/tree/elk-layered/d3-force × corpus × level), regenerated only via
      `pnpm goldens:update`.
- [x] `main` runs end-to-end via one documented command: `pnpm run ci` (and the
      CLI path `node apps/cli/dist/main.js layout <doc> --svg <out> [--provider
      <p>] [--worker]`).
- [x] ADR-0015/0016/0017/0018 written (4A), amended during 4C/4D/**4E**, and
      implemented as specified. **4E flags for the supervisor to fold into ADR
      text** (see the report): (a) ADR-0016 — d3-force's shipped stability
      mechanism is *hold persistent nodes fixed through the warm relaxation +
      centroid alignment*, the force analogue of 4D's elk amendment (pure
      warm-start + reduced alpha alone scored 0.32/0.88, below the floor);
      (b) ADR-0018 — the `C ≥ γ` disjunct never changes the return value (rules
      5 and 6 both return d3-force), so the `V_MAX` cost-guard skip is provably
      safe; the CLI default now uses `chooseProvider` (reconciling the 4B
      "default = grid" contract — level-0 corpus cuts are single nodes → grid).
- [ ] **UI verification (SVG quality review)** — UNVERIFIED — HUMAN, see section
      above.
- [ ] **Manual exploratory (pathology walk)** — UNVERIFIED — HUMAN, pathology
      notes recorded above; human eyeball confirmation pending.
- [ ] Gate closed by supervisor: verify the two human rows, then commit + `git
      tag phase-4`. (The model does not tag or commit — DRIVING-OPUS.md §4.)
