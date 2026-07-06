# Phase 3 — verification table & gate checklist

ROADMAP Phase 3 §12 walked row by row on 2026-07-06, every harness run for
real from a clean `pnpm install` (all numbers below are from this walk, not
asserted from memory). Human-judgment rows are explicitly marked
**UNVERIFIED — HUMAN** with the exact commands to run; the phase gate itself
(tag `phase-3`, M1 review) is closed by the supervisor, not the model
(DRIVING-OPUS.md §4).

## Verification table (ROADMAP Phase 3 §12)

| Category | Result | Evidence |
|---|---|---|
| Unit | **PASS** | `pnpm --filter @meridian/abstraction test` → 17 files, 90 tests, 0 failures |
| Integration | **PASS** | CLI suite → 5 files, 99 tests, 0 failures (34 new `cut` goldens + proposal round-trip) |
| Performance | **PASS** | `node benchmarks/abstraction-cut.bench.mjs` → cold 47.3 ms (≤ 150), warm 0.1 ms (≤ 30) |
| UI verification | N/A | Roadmap marks this row N/A for Phase 3 (headless) |
| Architecture | **PASS** | `pnpm depcruise` → no violations (120 modules, 330 deps); `pnpm audit:strings` clean |
| Manual exploratory | **PASS** (supervisor) | Book walk verified 2026-07-06; section below |
| Failure cases | **PASS** | empty/single-node/1M-leaves/removed-overrides all green (details below) |
| Regression | **PASS** | full uncached suite: 16 turbo tasks, 438 tests, 0 failures; goldens locked |

### Unit — cut construction, overrides, zoom mapping, I5, induced-vs-bruteforce

`pnpm --filter @meridian/abstraction test` → **17 files, 90 tests, all
passing** (uncached run, 2026-07-06). Row items map to:

- cut construction — `test/cut.test.ts` (7) + `test/coverage.property.test.ts`
  (4, fast-check over random spaces).
- override interactions (pin inside collapsed ancestor, …) —
  `test/override-matrix.test.ts` (10).
- zoom↔level mapping incl. hysteresis — `test/zoom-hysteresis.test.ts` (11).
- fast-check I5 — `test/resolver-i5.property.test.ts` (random spaces ×
  random overrides × random budgets).
- induced-edge-vs-bruteforce — `test/induced.property.test.ts` (2, equivalence
  on random graphs).
- resolver determinism, hash-verified (I6) —
  `test/resolver-determinism.property.test.ts` (2).

### Integration — `meridian cut` goldens at every level; proposals through the real store

- `apps/cli/test/cut-golden.test.ts` — **34 golden cases + 6 byte-free
  contract tests, all passing**: the six markdown corpus documents (`basic`,
  `links`, `commonmark-edges`, `pathological-nesting`, `no-headings`,
  `empty`) ingested through the real CLI pipeline and cut at **every** level
  (0…maxLevel, probed from the command under test), plus the four
  hand-written `fixtures/valid/` documents at every level, plus `--json`,
  `--focus`, and `--zoom` goldens. Goldens live in `fixtures/goldens/cli/
  cut.*` and regenerate **only** via `pnpm goldens:update` (never by hand).
- `apps/cli/test/proposal-cut.test.ts` — **2 tests passing**: deterministic
  `containmentRollupProvider` proposal → `applyProposal` → real `GraphStore`
  (one write path, invertible delta, actor `core:abstraction`) → snapshot
  encoded to disk → **CLI `meridian cut`** shows the grouping (coarse cut =
  2 `core:cluster` nodes covering all 5 leaves; fine cut = original members);
  re-applying the same proposal is refused (`id-collision`) with the store
  untouched. Package-level round-trip additionally covered by
  `packages/abstraction/test/apply-proposal.test.ts` (7 tests).

### Performance — 100k-node/8-level forest; exact cache invalidation

- `node benchmarks/abstraction-cut.bench.mjs` (also in `pnpm bench` /
  `pnpm run ci`), 2026-07-06, on this machine:
  `100000 nodes, 79997 base edges, 20003 graphs; cut@level 4: 640 members,
  512 induced edges` →
  **PASS abstraction-cut-cold-ms 47.3 ms (budget ≤ 150 ms)**,
  **PASS abstraction-cut-warm-ms 0.1 ms (budget ≤ 30 ms)** (thresholds
  pinned in `benchmarks/budgets.json`).
- Invalidation touches only affected ancestors —
  `packages/abstraction/test/induced-cache.test.ts` (7 tests incl. the churn
  property "stays equal to full re-aggregation while touching only endpoint
  covers", with recompute op-counts asserted).

### Architecture — `abstraction` imports `graph-core`/`graph-store` only

- `pnpm depcruise` → `✔ no dependency violations found (120 modules, 330
  dependencies cruised)`; rules `abstraction-only-core-and-store`,
  `abstraction-no-node-builtins`, `core-never-sees-plugins` all active. The
  one new edge this phase — `apps/cli → @meridian/abstraction` — was added
  to `cli-sees-only-core-packages` in the same change (the CLI is the
  composition root; the cut logic itself lives in the package, the CLI only
  formats).
- `pnpm audit:strings` → clean (no domain vocabulary in core packages).
- Public-API snapshot — `packages/abstraction/test/api-surface.test.ts`
  green.
- `pnpm lint` and `pnpm typecheck` → clean.

### Failure cases — empty, single node, 1M leaves, removed overrides

All automated and green in the abstraction suite:

- empty graph & single-node graph —
  `test/resolver-edge-cases.test.ts` (4).
- forest with 1M leaves under one parent (budget must kick in) —
  `test/budget.test.ts` (5; the 1M-leaf resolve collapses to the parent in
  one rollup, ~4 s wall on this machine, well inside the test budget).
- override map referencing removed nodes → ignored + traced (`removed`),
  never thrown — `test/overrides-removed.test.ts` (3).
- CLI contract failures (no goldens: contracts, not bytes) —
  `apps/cli/test/cut-golden.test.ts`: both/neither of `--level`/`--zoom`,
  malformed values → exit 2 + usage; missing `--focus` node → exit 1 on
  stderr; invalid document → exit 1 `INVALID`.

### Regression — P0–P2 suites; new goldens locked

- Full uncached monorepo suite (`pnpm test --force`), 2026-07-06:
  **16 turbo tasks, 48 test files, 438 tests, 0 failures** —
  graph-core 96 · graph-store 85 · plugin-api 4 · plugin-host 26 ·
  conformance-kit 11 · adapter-markdown 27 · abstraction 90 · cli 99.
- `pnpm run ci` (lint → typecheck → depcruise → audit:strings → build →
  test → bench) — green end to end; every budget in
  `benchmarks/budgets.json` PASS (decode 481.7 ms/1500, stats 6.7 ms/200,
  store-delta 21.0 ms/50, transactions 93.1 ms/2000, snapshot 2.4 ms/100,
  version-chain share 99.90 %/≥90 %, ingest-5MB 905.2 ms/2000, cut cold
  47.3 ms/150, cut warm 0.1 ms/30).
- 34 new `cut.*` goldens locked under `fixtures/goldens/cli/`; the P0–P2
  goldens are byte-unchanged (`git status` shows only additions).

## Manual exploratory — UNVERIFIED — HUMAN

*"Walk a real book through every level via CLI; sanity-judge whether each
cut 'reads' like a sensible summary of the one below."* (ROADMAP §12.)
Judgment of "reads sensibly" is yours; the mechanical walk is:

```sh
pnpm build
# any real markdown book works; the richest in-repo corpus files:
pnpm meridian ingest fixtures/corpora/markdown/links.md --out /tmp/book.meridian.json
# find the finest level:
pnpm meridian cut /tmp/book.meridian.json --level 0 --json | grep maxLevel
# then judge each cut against the one below it:
pnpm meridian cut /tmp/book.meridian.json --level 0
pnpm meridian cut /tmp/book.meridian.json --level 1
pnpm meridian cut /tmp/book.meridian.json --level 2
pnpm meridian cut /tmp/book.meridian.json --level 3
# continuous zoom + focus trace:
pnpm meridian cut /tmp/book.meridian.json --zoom 0.42
pnpm meridian cut /tmp/book.meridian.json --level 1 --focus <a node id from the level-1 output>
```

- [x] **VERIFIED (supervisor walk, 2026-07-06):** walked a 3-part /
      6-chapter / 10-paragraph book through all 4 levels of the default
      markdown chain. Level 0 = title, 1 = parts, 2 = chapters,
      3 = paragraphs; each cut reads as a sensible summary of the one
      below; coverage 10/10 at every level; out-of-range `--level 4`
      clamps to the finest level without error. Cosmetic nit: the clamped
      run echoes `zoom 1.125` (outside [0,1]) in the header — tracked for
      a P6 polish pass, not gate-blocking.

## Definition of Done (ROADMAP Phase 3 §13; gate rules §5.1)

- [x] Every automated verification-table row passes in CI —
      `pnpm run ci` green, 2026-07-06 (rows above).
- [x] Demo performed: `docs/demos/m1.md` (all-CLI ingest → mutate → cut);
      **every command in it was executed for real** this session — including
      determinism (`cmp` byte-identical) and undo (inverted delta restores
      the level-1 cut exactly).
- [x] `main` runs end-to-end via one documented command: `pnpm run ci`
      (and the demo path `pnpm meridian ingest|mutate|cut`).
- [x] ADR-0012, ADR-0013, ADR-0014 written, amended during 3C/3D, and
      implemented as specified (zoom-policy.ts documents the one flagged
      subscript deviation folded back into ADR-0012's text).
- [x] ADR-0012/0013/0014 accepted at gate close (supervisor, 2026-07-06):
      merged with recommended defaults on all open questions; repo
      convention keeps `Status: Proposed` in the header (matches
      ADR-0001–0011) — merged = finalized per CLAUDE.md.
- [x] Manual exploratory book walk — VERIFIED, see section above.
- [x] Gate closed by supervisor (delegated), commit + `git tag phase-3`,
      2026-07-06. **M1 review remains open for the project owner** — the
      evidence bundle is this checklist plus `docs/demos/m1.md`; the tag
      can be dropped if the review finds fault. The visual track (P4–P6)
      and the domain track (P7) may proceed in parallel.
