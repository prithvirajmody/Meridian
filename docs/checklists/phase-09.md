# Phase 9 — verification table & gate checklist

ROADMAP Phase 9 §12 walked row by row on **2026-07-15** (subphases 9C/9D/9E;
9A/9B were committed 2026-07-14). Automated numbers are from commands run
against this worktree with AI keys stripped — every AI path below is mock or
replay, zero network. Rows that require human judgement, a live provider
recording, or the milestone review remain **UNVERIFIED** and unchecked. This
document does not close the phase gate; per `DRIVING-OPUS.md`, the user owns
the `phase-9` and `plugin-api@1.0` tags.

## Headline evidence

| Signal | Result | Command |
|---|---|---|
| Conversation adapter | **105 tests / 6 files, 0 failures** (formats, exchanges, IR, plugin, 1k-msg perf, conformance) | `pnpm --filter @meridian/adapter-conversation test` |
| Argument adapter | **34 tests / 4 files, 0 failures** (segmentation, IR, plugin, conformance incl. reject/) | `pnpm --filter @meridian/adapter-argument test` |
| Enrichment CLI suites | **18 tests / 2 files, 0 failures** (replay goldens, idempotency, budget-0 floors, replay-miss, consent) | `pnpm --filter @meridian/cli exec vitest run test/enrich.test.ts test/enrich-argument.test.ts` |
| plugin-api 1.0 gate | **7 tests + api-extractor verify green** (`etc/plugin-api.api.md` matches dist) | `pnpm --filter @meridian/plugin-api test` |
| Phase-9 browser E2E | **9 Playwright tests, 0 failures** (document-open ×3 incl. both domains + AI filter; ai-trust ×6) | `pnpm --filter @meridian/studio exec playwright test document-open.spec.ts ai-trust.spec.ts` |
| Eval harness | **infra 2/2; offline gate: all floors held** incl. `argmap-structural-valid-min 1.000` + argmap determinism + golden | `pnpm test:evals` · `node evals/run.mjs` |
| Full regression | **36 turbo test tasks green** (serialized run) | `pnpm exec turbo run test --concurrency=1` |
| Dependency architecture | **no violations (451 modules, 1411 dependencies)** | `pnpm depcruise` |

## Verification table (ROADMAP Phase 9 §12)

| Category | Result | Evidence |
|---|---|---|
| Unit | **PASS** | Export-format parsers (Claude/ChatGPT incl. truncated/hand-edited/NUL rejects) and skeleton builders: 105 conversation + 34 argument tests. Enrichment merge logic idempotent by `inputHash`: re-run over an enriched document is a **byte-identical no-op** for both domains (`enrich.test.ts`, `enrich-argument.test.ts`); changed-hash replacement paths exercised via the replace counters. |
| Integration | **PASS (replay)** | Full ingest→zoom goldens for both domains from the **committed** fixture stores (`fixtures/ai/enrich.{conversation,argument}.fixtures.json`), cut at every level (`cut.conv.two-topics*.txt`, `cut.arg.pedestrian*.txt`), run with keys stripped from the environment. Conformance suite ×2 (kit-driven, both adapters, reject/ containment). |
| Performance | **PASS** | 1k-message skeleton ingest < 3 s (conversation `performance.test.ts`). Enrichment is budgeted end-to-end: `--budget` flows to `BudgetGuard`; budget-0 floors every unit and leaves the byte-identical skeleton (both domains, tested). Enrichment is per-unit batched (per session/message/paragraph calls, ADR-0032 unit-of-one). |
| UI verification | **PASS** | Playwright: enriched conversation zooms session → AI topics → exchanges → messages; enriched essay overlays the argument map at paragraph level; AI-provenance filter hides and losslessly restores all AI structure in both domains (`document-open.spec.ts`); accept/reject/auto-accept trust surface (`ai-trust.spec.ts`). |
| Architecture | **PASS** | api-extractor 1.0 snapshot gate live: the committed report is verified inside `plugin-api`'s test script, so drift fails CI; `PLUGIN_API_VERSION = 1.0.0`; all first-party manifests migrated to `^1.0.0` and re-passed conformance. Adapters isolated as ever (depcruise clean; adapter packages import plugin-api only; enrichment lives in the composition root per ADR-0034). |
| Manual exploratory | **UNVERIFIED — HUMAN** | Ingest a *real personal* conversation export and judge the topic labels; ingest a real op-ed and judge the argument map against your own reading. (The committed corpus stands in for CI; the judgement row is yours. Live-model labels additionally need a recorded fixture — see the live-recording item below.) |
| Failure cases | **PASS** | Truncated/hand-edited exports and binary junk contained (conformance reject/ suites both domains); one-message conversation fixture ingests; AI unavailable → degraded-but-working skeleton **explicitly tested** (budget-0 byte-identical floor, both domains); replay cache miss is a hard failure, never a network fallback; live mode refuses without `--ai-consent`. |
| Regression | **PASS** | Entire prior suite green under the freeze: 36/36 turbo test tasks (serialized), typecheck, lint, depcruise, string audit, evals. `plugins.list` goldens regenerated for the two new adapters + 1.0 migration via the documented command. Note: `layout` worker-latency and `watch` fs.watch tests are load-sensitive — they pass serialized/isolated but can flake under a parallel turbo run on a loaded host (pre-existing, phase-07/08 notes). |

## Acceptance criteria (ROADMAP §11)

- [x] Both adapters pass conformance.
- [x] A real exported conversation zooms topics→messages with AI topic labels in Studio *(scripted: `document-open.spec.ts`; replayed AI)*.
- [ ] **UNVERIFIED — HUMAN:** argument map of a known essay judged faithful against the human-made reference map — the metric + reference exist (`evals/lib/argmap-metrics.mjs`, `evals/fixtures/argmap-reference.json`; ADR-0034 Q2 settled) and gate live recordings; the *judgement* (and review of the reference map itself) is yours at M3.
- [ ] **UNVERIFIED — HUMAN:** plugin-api 1.0 **tagged** (`plugin-api@1.0`; the freeze is in the tree and CI-gated, the tag is the seal).
- [ ] **UNVERIFIED — HUMAN:** toy-adapter exercise re-run against the 1.0 docs (`docs/guides/plugin-authors.md`) by a fresh person in < 1 hour. (The exercise itself is migrated to `^1.0.0` and green: `packages/conformance-kit/test/toy-todo.test.ts`.)

## Definition of Done (ROADMAP §13)

- [x] Chafe report resolved — `docs/chafe-report-plugin-api-1.0.md`: every item FIXED or explicitly DEFERRED with an additive 1.x path.
- [x] Three-domain demo **script** — `docs/demos/m3.md` (repo-convention path; the ROADMAP §13 `docs/meridian/demos/` path is a typo, per ADR-0033 finalization).
- [ ] **UNVERIFIED — HUMAN:** M3 review held; demo recorded (`docs/demos/m3.webm`).
- [ ] **UNVERIFIED — HUMAN:** ADR-0033 and ADR-0010 flipped Proposed → Accepted at the review.
- [ ] **UNVERIFIED — HUMAN:** tags `phase-9` + `plugin-api@1.0` cut.

## Carried-forward human items touching this phase

- Live AI fixture recordings (8C human step) — includes `--task argmap`
  (`evals/run.mjs --record … --task argmap --consent-live`), which arms the
  `argmap-node-f1-min` / `argmap-edge-f1-min` quality floors.
- Prior human gates still open: M2 review + `phase-5`/`phase-6` tags, Phase 4
  SVG review, `phase-7` tag, Phase 8 human rows (`checklists/phase-08.md`).
