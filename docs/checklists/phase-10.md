# Phase 10 — verification table & gate checklist

ROADMAP Phase 10 §12 walked row by row on **2026-07-15** (subphases 10D/10E/
10F; 10A–10C were committed the same day after their own gates). Automated
numbers are from commands run against this worktree. Rows that require human
judgement or the milestone-style review remain **UNVERIFIED** and unchecked.
This document does not close the phase gate; per `DRIVING-OPUS.md`, the user
owns the `phase-10` tag (and the still-pending `plugin-api@1.0` seal, which
1.1.0 builds on additively).

## Headline evidence

| Signal | Result | Command |
|---|---|---|
| Projections package | **39 tests / 7 files, 0 failures** (matrix ordering + selection mapping + 2k×2k draw list 57 ms; timeline lanes/degradation/view-state; map/outline/registry; api-surface; architecture) | `pnpm --filter @meridian/projections test` |
| View-model temporal | **30 tests / 7 files, 0 failures** (ISO-8601 / epoch-seconds / numeric-string normalization, descendant roll-up, located diagnostics, options overlay) | `pnpm --filter @meridian/view-model test` |
| Renderer media | **110 tests / 17 files, 0 failures** (projection canvas draw order/coalescing/input mapping/idempotent teardown; outline virtual list; scene) | `pnpm --filter @meridian/renderer test` |
| Studio unit + property | **83 tests / 16 files, 0 failures** — includes the ADR-0036 random-switch-sequence property (60 fast-check runs) and the plugin twin bridge | `pnpm --filter @meridian/studio test` |
| plugin-api 1.1 gate | **7 tests + api-extractor verify green** (`etc/plugin-api.api.md` regenerated via `pnpm api:update` for presentation hints + `viewProjections`) | `pnpm --filter @meridian/plugin-api test` |
| plugin-host routing | **29 tests, 0 failures** (view-projection declared/exported mismatch, duplicate-id conflict, deterministic ordered resolution) | `pnpm --filter @meridian/plugin-host test` |
| Phase-10 browser E2E | **18 Playwright tests, 0 failures** — outline ×5, matrix ×5, timeline ×2, mode-switch ×6 (4×3 matrix incl. baselines) | `pnpm --filter @meridian/studio exec playwright test outline-projection matrix-projection timeline-projection mode-switch` |
| Full regression | **38 turbo test tasks green** (serialized run) | `pnpm exec turbo run test --concurrency=1` |
| Dependency architecture | **no violations (486 modules, 1513 dependencies)** | `pnpm depcruise` |

## Verification table (ROADMAP Phase 10 §12)

| Category | Result | Evidence |
|---|---|---|
| Unit | **PASS** | Suitability functions for all four projections (map 1/0, outline density, matrix meaningfulness, timeline hints×data — each with zero cases); view-state capture/restore round-trips with malformed-state diagnostics for outline, matrix, timeline; matrix cluster ordering (containment groups, connected-component fallback, unconnected trail, determinism under input permutation); outline virtualization windowing (10C suite). |
| Integration | **PASS** | The 4×3 Playwright mode-switch matrix (map/outline/matrix/timeline × markdown/conversation/argument) with selection identity asserted after every switch (`mode-switch.spec.ts`); selection-survival property over random switch sequences incl. rapid unawaited switches and a mount-throwing projection (60 fast-check runs, `studio-projection-switch.property.test.ts`). The property surfaced and now pins a real convergence bug: an A→B→A re-click during B's mount previously settled on stale B (fixed via the request guard). |
| Performance | **PASS** | Outline 100k rows ≥ 55 fps sustained scroll with bounded DOM pool (10C e2e, re-run green); matrix 2k×2k: 57 ms headless draw-list build (< 500 ms budget) and 67 ms in-browser switch+first-paint (`matrix-2k-render-ms` budget in `budgets.json`); switch itself p95 19–24 ms across all three domains (< 200 ms `projection-switch-ms` budget, measured over the full 4×3 cycle). |
| UI verification | **PASS** | Screenshot baselines per projection × domain (12 baselines under `mode-switch.spec.ts-snapshots/` (4 modes × 3 domains), stable across a clean re-run); keyboard nav in outline (10C spec re-run green: Home/End/Enter/arrow semantics, aria-activedescendant, selection readback). |
| Architecture | **PASS** | depcruise clean: projections imports only view-model+layout (rule `projections-only-view-model-and-layout`, incl. type-only edges); no store write path reachable from any projection (mutation enters only via the host's selection/navigation intents); map projection passes the pre-refactor goldens (10B byte-identical gate; corpus-visual suite green in the final full e2e run). plugin-api 1.1.0 additive under the freeze: api-extractor report regenerated via the documented command, changelog entries, `^1.0.0` manifests unchanged, twin pinned by compile-time assignability (`projection-twin.test.ts`), ADR-0037 amended with the two build rulings (public facade omits the node-link medium; `ProjectionModelView` is a slice). |
| Manual exploratory | **UNVERIFIED — HUMAN** | Real tasks in wrong-looking modes: "find the dense module in matrix" on a code/markdown corpus, "skim the argument in outline" on a real essay — friction notes are yours to take at the review. |
| Failure cases | **PASS** | Switch mid-transition: deterministic-clock e2e freezes a zoom mid-flight, switches, and asserts the semantic intent completed with interpolation cancelled (ADR-0036 step 3) and a clean round trip back to map. Projection throwing on mount → host contains, atomic fallback to map with located diagnostic (headless coordinator test, the property's bomb projection, and the in-browser `registerBombProjection` e2e). Timeline on an atemporal domain → specific degraded message, selection kept, switching away works; matrix on an edgeless cut → degraded message. Terminal double-failure (map also unmountable) → deterministic failure message, identity state retained. |
| Regression | **PASS** | Entire prior suite green: 38/38 turbo test tasks (serialized), typecheck 36/36, depcruise, and the **full Playwright suite 58/58 in one idle-host run (7.2 min)** — corpus-visual and mid-transition baselines unchanged under the new topbar switcher (no golden regen needed). `plugins.list` golden regenerated via the documented command for the 1.1.0 `apiVersion`. Known env-sensitive rows unchanged from phase-07/08/09 notes: `layout` worker-latency and `watch` fs.watch tests pass serialized/isolated but can flake under parallel turbo load; the 10k-fixture FPS and 5-min heap-soak specs are host-load-sensitive and both passed in this idle-host run. |

## Acceptance criteria (ROADMAP §11)

- [x] All four projections work on all three domains where applicable — outline/matrix e2e cover all three; timeline renders conversations via declared `conv:timestamp`/`conv:role` metadata and **degrades with a message** (never crashes) on markdown/argument.
- [x] Switching preserves state per ADR-0036 — property test over random switch sequences (identity by reference, per-projection view-state round-trip, convergence to the final request, no instance leaks) plus the in-browser 4×3 matrix and outline-scroll round-trip.
- [x] Map goldens byte-identical post-refactor (10B gate; corpus-visual baselines still green).

## Definition of Done (ROADMAP §13)

- [x] Projection-author guide section added to the plugin docs (`docs/guides/plugin-authors.md` §"Writing a view projection"); the `view-projection` capability is authorable public API (plugin-api 1.1.0: `PluginExports.viewProjections`, host validation, structural twins).
- [ ] **UNVERIFIED — HUMAN:** phase gate closed by you; `phase-10` tag cut.
- [ ] **UNVERIFIED — HUMAN:** manual-exploratory friction notes taken (see above).

## Carried-forward human items

- `phase-5`…`phase-9`, `plugin-api@1.0` tags and the M2/M3 reviews remain
  pending from earlier phases (see `checklists/phase-05..09.md`); the 1.1.0
  version in the tree is additive on the frozen-but-untagged 1.0 surface.
- Live AI recordings and the fresh-person toy-adapter exercise (phase 8/9
  checklists) are unaffected by Phase 10.
