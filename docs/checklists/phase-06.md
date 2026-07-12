# Phase 6 — verification table & gate checklist

ROADMAP Phase 6 §12 walked row by row on 2026-07-13; every number below comes
from a harness run in the 6E gate session in the phase-6 worktree (none
asserted from memory). Human-judgment rows are explicitly marked
**UNVERIFIED — HUMAN** with the exact commands to run; the phase gate itself
(tag `phase-6`) closes per DRIVING-OPUS.md §4 after the **M2 review**.

Subphases: 6A ADRs 0023–0025 (drafts `5f1b4f2`, accepted `b8c4fb9`),
6B `@meridian/navigation` (`4806a15`), 6C controller & URL state (`e51cd9f`),
6D Studio choreography (`a62debb`), 6E tuning panel & gate materials is this
commit.

## Verification table (ROADMAP Phase 6 §12)

| Category | Result | Evidence |
|---|---|---|
| Unit | **PASS** | navigation → 15 files, **117 tests**: choreographer plans on hand-built cut diffs (`choreographer/degrade/refinement/determinism.test.ts` — enter-spawn/exit-merge geometry, all three degrade triggers isolated, deep-equal determinism), anchor math (`anchor.test.ts` + `anchor.property.test.ts` fast-check: mapped point ∈ R_in, zoom-in∘zoom-out round-trip), hysteresis state machine (`controller.zoom.test.ts` — 50-cycle oscillation at a threshold ⇒ **0 cut-flaps**, both directions), URL codec (`url.test.ts` — round-trip, percent-encoding, `URL_MAX` truncation), 6E tunables (`tunables.test.ts`, 17 tests — defaults ≡ ADR constants, frozen; per-trigger overrides; §16.1 clamp; live controller provider). studio → 9 files, **55 tests** incl. `tunables.test.ts` (8: session-copy round-trip, reset restores `NAV_TUNABLE_DEFAULTS`, sanitize windows, spec table covers every key, edited `BASE_TRANSITION_MS`/`MAX_ANIMATED_NODES` land on the *next* transition on the ManualClock) |
| Integration | **PASS** | Playwright `navigation-descent.spec.ts`, scripted wheel descents **and** ascents on 3 corpora through the real pipeline: `basic.md` 5 transitions choreographed, `links.md` 5 (choreographed+crossfade), `pathological-nesting.md` 9 choreographed — per corpus **maxDriftPx=0.000**, maxPlanMs ≤ 1.10, maxPlanToSettleMs ≤ 248.4 (≤ 300 budget); plus "the book descent: drill-in/out stack integrity and URL round-trip" (breadcrumb trail ≡ stack, drill-out restores saved view exactly, fragment restores in a fresh page) |
| Performance | **PASS** | `transition-performance.spec.ts`: live descent/ascent, 273 flight frames sampled → **p95 frame 1.40ms ≤ 22ms** (mean 0.55ms, guardTrips 0, maxDriftPx 0.000); plan computation on 5k-node cut diffs → `benchmarks/navigation-plan.bench.mjs`: scenario A (cut diff) 2.37ms, scenario B (choreographed re-layout) 2.84ms → **PASS navigation-plan-5k-ms 2.84/20ms** |
| UI verification | **PASS** (automated) / **UNVERIFIED — HUMAN** (recordings review) | `transition-baselines.spec.ts` under `?clock=manual` (ADR-0023 injected time): frozen frames at t≈25%/62.5%/settled on 2 corpora match all **6 mid-transition goldens** (committed `a62debb`, byte-unchanged by 6E); `tunables-panel.spec.ts` (3 tests): panel opens behind `?debug=1`, edit BASE_TRANSITION_MS 240→120 → next transition `durationMs=120` and settled at exactly t=120 on the frozen clock, reset → 240; flag off ⇒ panel/HUD **absent** (`toHaveCount(0)`). **Visual continuity review from recordings: UNVERIFIED — HUMAN** (record per `docs/demos/m2.md`, review the descent shots) |
| Architecture | **PASS** | `pnpm depcruise` → **no violations (282 modules, 814 dependencies)** incl. `navigation-only-abstraction-and-view-model` (§20: navigation imports `abstraction`+`view-model` only — never pixi/renderer/DOM/store) and `navigation-no-node-builtins`; `pnpm audit:strings` clean; the 6E panel is React-only (`TunablesPanel.tsx` imports navigation types + Zustand store; `studio-react-never-imports-pixi-or-renderer-internals` still green) |
| Manual exploratory | **UNVERIFIED — HUMAN** | The "grandmother test" — someone uninvolved zooms a book unprompted; notes filed. Commands below |
| Failure cases | **PASS** | Zoom during in-flight transition → **retarget, not queue**: `transition-baselines.spec.ts` "retarget-not-queue is drivable on the frozen clock" (first record `superseded=true, settledAtMs=null`; successor `replannedFromFlight=true`) + unit twin in `studio-navigator.test.ts`; drill into node with no detail → located no-op with `no-detail` notice, nothing thrown (`controller.drill.test.ts`, `studio-navigator.test.ts`, e2e probe in `navigation-descent.spec.ts`); store mutation mid-transition → P1 subscription forces replan from the interpolated frame (`transition-baselines.spec.ts` mutation test: prior flight superseded, successor `trigger='mutation'`, `replannedFromFlight=true`, mutated label searchable after settle) |
| Regression | **PASS** (one environmental note) | Full suite green from the worktree root, staged per `pnpm run ci`: lint ✓ · typecheck ✓ · depcruise ✓ · audit:strings ✓ · build ✓ · `turbo run test --force --concurrency=1` → **28/28 tasks, 1008 tests passed, 0 failed** (graph-core 96 · graph-store 85 · abstraction 90 · view-model 19 · layout 94 · navigation 117 · renderer 92 · plugin-api 4 · plugin-host 26 · conformance-kit 11 · adapter-markdown 27 · adapter-code 17+1 pre-existing skip · cli 275 · studio 55) · `pnpm test:e2e` → **31/31 passed (6.4m)** incl. the 5-min heap soak · bench: **all 15 budget keys PASS**. Goldens: **19** corpus-visual + **6** mid-transition PNGs and all CLI/SVG fixtures **byte-unchanged** (`git status` shows no snapshot/fixture modifications — the debug panel is invisible with the flag off). See 10k-FPS environmental note below |

### 5F 10k FPS probe — environmental note (host-load sensitivity)

`performance.spec.ts` ("10k labelled fixture keeps the frame budget: draw
p95 ≤ 18ms, ≥ 55fps sustained") **passed in this gate run** (31/31 above,
host quiet). The same spec **fails on this host under concurrent load in all
configurations, including committed 5F-era code**: measured in this session
**draw p95 46.7ms** (run with parallel sessions active), and the supervisor
measured **61.7ms** on the main tree at committed 5F code. The failure is
environmental (SwiftShader software raster + loaded CPU), not a Phase 6
regression — the phase-05 checklist's FPS-gate note already records that the
wall-clock claim is certified on real GPU hardware at each gate. Re-verify on
an idle host or real GPU at the M2 review; do not chase in code.

Related honesty note: `layout/test/worker-host.test.ts` ("main thread stays
responsive, no > 4ms gap") is likewise wall-clock-sensitive — it flaked once
(maxGap 4.99ms vs 4ms) when all 14 vitest suites ran concurrently under
`--force`, and is green sequentially (`--concurrency=1`, the run recorded
above) and in isolation. Same environmental class, prior-phase test, untouched
by 6E.

### Performance details

- Transition FPS — `transition-performance.spec.ts` on a live `basic.md`
  descent/ascent (real clock, real renderer): 5 settled transitions, 273
  draw-time samples during flights → p95 1.40ms, mean 0.55ms, max plan 1.10ms,
  max layout 0.8ms, ADR-0023 runtime guard never tripped.
- Plan budget — `pnpm bench` (2026-07-13): `navigation-plan-5k-ms` 2.84ms
  (budget ≤ 20ms) on a 5,040-member cut diff; full budget table all PASS
  (decode 364.1/1500 · ingest-5MB 674.6/2000 · cut cold 33.8/150 · elk-2k
  504.1/1500 · force-10k 1011.5/3000 · stability 1.000/≥0.90 · …).
- Anchor — every settled transition in every descent recorded
  `maxDriftPx = 0.000` against the < 8px gate (`transition-anchor-drift-px`);
  drift is re-solved per frame (ADR-0024 closed-form center), so the gate
  measures the whole flight, not endpoints.

### 6E deliverable details

- **Panel** — `apps/studio/src/components/TunablesPanel.tsx`, rendered only
  when `debugEnabled` (`?debug=1`), alongside the 5E FPS/heap HUD. Live
  tunables (all ADR-named): `BASE_TRANSITION_MS`, `CROSSFADE_MS`,
  `MAX_ANIMATED_NODES`, `STABILITY_DEGRADE_FLOOR`, `SOURCELESS_MAJORITY`
  (ADR-0023); `ANCHOR_SNAP` (ADR-0024); `OVERZOOM_MAX`, `FRAME_MARGIN`,
  `KEY_ZOOM_FACTOR`, `READABLE_LEAF_PX` (ADR-0025); the shared easing is
  displayed **view-only** (one curve is the ADR-0023 decision, not a knob).
  Edits apply on the next transition/verb without reload.
- **Frozen defaults** — `packages/navigation/src/tunables.ts`:
  `NAV_TUNABLE_DEFAULTS`, a frozen object built *only* from the constants in
  `constants.ts` (no literals of its own; unit-asserted equal, key for key).
  The panel edits a session copy in the Zustand store
  (`StudioState.tunables`); "Reset to ADR defaults" restores the frozen
  object. `MAX_TRANSITION_MS = 300` and `URL_MAX` are deliberately **not**
  tunable (constitutional §16.1 budget / wire cap); plan durations clamp to
  300ms regardless of panel input.
- Scale-range tunables (`READABLE_LEAF_PX`, `FRAME_MARGIN`) feed
  `deriveScaleRange` at each derivation; ranges are memoized per graph, so
  those two take effect on the next *context* (boot/first drill), while all
  transition/anchor/zoom tunables take effect on the next transition — noted
  in the panel ("Edits apply from the next transition").

## Manual exploratory — UNVERIFIED — HUMAN

*"The 'grandmother test': someone uninvolved zooms a book unprompted — do
they understand what's happening? Notes filed."* (ROADMAP §12.)

```sh
pnpm dev          # then open http://127.0.0.1:5173/
# Open corpus → fixtures/corpora/markdown/links.md
# Hand over the mouse, say nothing. Watch for:
# - do they realize zoom *changes what things are*, not just size?
# - does the anchor hold where they point (no "where did it go")?
# - do they find drill-in (Enter) / out (Esc) and the breadcrumbs?
# File notes (what confused, what delighted) with the M2 review record.
```

- [ ] **UNVERIFIED — HUMAN:** grandmother test run and notes filed.

## Manual tuning session — UNVERIFIED — HUMAN

The 6E feel gate (DRIVING-OPUS.md §4: feel judgments stay human). The shipped
defaults are the ADR-ruled values; this session may re-tune them.

```sh
pnpm dev          # then open http://127.0.0.1:5173/?debug=1
# Open a corpus, open the Tunables panel (top-right), and drive descents while
# adjusting BASE_TRANSITION_MS / CROSSFADE_MS / degrade thresholds / ANCHOR_SNAP
# / OVERZOOM_MAX / KEY_ZOOM_FACTOR. "Reset to ADR defaults" is always safe.
# If a different value feels strictly better, record it: the freeze procedure
# is (1) amend the ADR constant + note, (2) change constants.ts, (3) the
# defaults module and panel follow automatically (they carry no literals).
```

- [ ] **UNVERIFIED — HUMAN:** tuning session held; defaults confirmed or
      re-tuned via the ADR-amendment path above; feel signed off personally.

## Definition of Done (ROADMAP Phase 6 §13)

- [x] Phase gate passes — `pnpm run ci` stages run individually from the
      worktree root, 2026-07-13, all green: lint → typecheck → depcruise
      (282 modules, 0 violations) → audit:strings → build →
      `turbo run test --force --concurrency=1` (**1008 tests, 0 failures**)
      → `pnpm test:e2e` (**31/31 passed, 6.4m**, incl. the 5-min heap soak
      and the 10k FPS probe — see environmental note) → bench (**all 15
      budgets PASS**, `navigation-plan-5k-ms` 2.84/20ms).
- [ ] **M2 review held** — UNVERIFIED — HUMAN: recorded demo of the book
      descent + live walkthrough per `docs/demos/m2.md` (script committed;
      recording and the live session are the human gate — DRIVING-OPUS.md §4).
- [x] Constants frozen into defaults — the *mechanism* is frozen:
      `NAV_TUNABLE_DEFAULTS` (ADR values, no independent literals), panel
      edits a session copy only, reset restores defaults, all covered by unit
      + e2e tests.
- [ ] Constants *tuned* — UNVERIFIED — HUMAN: the manual tuning session above
      must confirm (or re-tune, via ADR amendment) the shipped ADR values.
- [x] `docs/demos/m2.md` script committed (repo convention `docs/demos/`,
      matching M1 — the roadmap's `docs/meridian/demos/` path predates the
      repo layout).
- [ ] Gate closed by supervisor: verify the human rows, then `git tag phase-6`
      (DRIVING-OPUS.md §4 — the model proposes done; you declare done).
