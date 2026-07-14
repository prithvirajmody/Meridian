# Phase 8 — verification table & gate checklist

ROADMAP Phase 8 §12 walked row by row on **2026-07-13**. The automated
numbers below are from commands run against this worktree. Rows that require a
real provider call, committed live recording, measured provider cost, or human
judgement remain **UNVERIFIED** and unchecked. This document does not close the
phase gate; per `DRIVING-OPUS.md`, the user owns the final `phase-8` tag.

## Headline evidence

| Signal | Result | Command |
|---|---|---|
| `@meridian/ai` | **88 tests / 16 files, 0 failures** (the earlier 81-test count grew during remediation) | `pnpm --filter @meridian/ai test` |
| `@meridian/ai-services` | **55 tests / 7 files, 0 failures** | `pnpm --filter @meridian/ai-services test` |
| CLI AI surface | **13 AI tests, 0 failures**; full CLI **320 / 11 files** | `pnpm --filter @meridian/cli test` (`test/ai.test.ts`) |
| Studio AI unit surface | **20 focused tests** (`6 + 6 + 7 + 1`); full Studio **75 / 13 files** | `pnpm --filter @meridian/studio test` |
| Studio AI browser E2E | **6 Playwright tests, 0 failures** | `pnpm --filter @meridian/studio exec playwright test e2e/ai-trust.spec.ts` |
| Fake record → replay | **2 tests, 0 failures**, fetch blocked, temporary artifacts only | `pnpm test:evals` |
| Offline quality gate | **purity 1.000 · ARI 1.000 · structural validity 1.000 · deterministic · goldens match** | `node evals/run.mjs` |
| Replay overhead | **p50 0.030 ms · p95 0.051 ms** (budget ≤ 5 ms) | `pnpm bench` |
| 5k-node cluster compute | **229.3 ms** (budget ≤ 2000 ms) | `pnpm bench` |
| Dependency architecture | **no violations (420 modules, 1321 dependencies)** | `pnpm depcruise` |

Benchmark timings are machine/run dependent; the versioned budgets, not these
particular samples, are the contract.

## Verification table (ROADMAP Phase 8 §12)

| Category | Result | Evidence |
|---|---|---|
| Unit | **PASS** | `@meridian/ai` 88/88: routing, provider/model cache identity, replay metering, `BudgetGuard`, consent, schema validation + one repair, retry/cancel, Anthropic/OpenAI structured parity, and adapter normalization. All provider clients are injected; no test uses live network. |
| Integration | **PASS (offline); live fixture replay UNVERIFIED** | `@meridian/ai-services` 55/55 covers summarize/cluster/extract plus proposals → store → cut. CLI `meridian ai summarize` / `cluster` have 13 tests covering mock, replay misses, budget-as-dollars, consent/key guards, and flag hygiene. `pnpm test:evals` records both service tasks with fake providers to durable temporary JSON and replays all objective floors with provider callbacks that throw if touched. A committed live recording over the P7 repo is still absent. |
| Performance | **PASS (offline); live network target UNVERIFIED** | Both AI scripts now run inside `pnpm bench` (and therefore `pnpm ci`): replay p95 **0.051 ms ≤ 5 ms**; 5k-node embed-pipeline + clustering compute **229.3 ms ≤ 2000 ms**. The `<10 s` live embedding round-trip needs a key and remains unchecked. |
| UI verification | **PASS** | Studio unit surface: provenance filtering 6, AI store 6, trust controller 7, session pipeline 1. Playwright 6/6 verifies pending-by-default, visible badge after accept, reject writes nothing, lossless filter toggle, per-service auto-accept, cancellation, and no network requests. |
| Architecture | **PASS, with one recorded budget-policy gap** | Dependency cruise is clean; each vendor SDK is confined to its client adapter. Anthropic/OpenAI routing is configuration. ADR-0029, ADR-0030, and ADR-0031 are Accepted. ADR-0032 remains Proposed because the per-session guard exists but the constitution's durable cumulative **per-project** ceiling does not yet. |
| Manual exploratory | **UNVERIFIED — HUMAN** | No live summaries or `evals/ratings/module-summaries.ratings.json` exist. Record with explicit consent, then rate 20 summaries using `evals/RUBRIC.md`. |
| Failure cases | **PASS (automated modes)** | 429/5xx/network backoff, refusal, content filter, malformed structured output → one repair → reject, cancellation, replay miss, and budget stop with valid partial summary state are directly tested. Injected clients and mock providers make these deterministic and zero-network. |
| Regression | **PASS (mock/fake); live recordings UNVERIFIED** | Mock goldens match after regenerating the node-soup confidence golden through `--update-golden` for the corrected cohesion formula. Fake record output replays green; misses cannot fall through to providers. No live vendor snapshot is committed, so provider/model regression replay is not claimed. |

## Objective floors

`node evals/run.mjs`:

```text
PASS  cluster-purity-min                 1.000  (floor ≥ 0.95)
PASS  cluster-ari-min                    1.000  (floor ≥ 0.9)
PASS  summary-structural-valid-min       1.000  (floor ≥ 1)
PASS  summarize-deterministic            true
PASS  cluster-deterministic              true
PASS  golden:module-summaries.mock.json  match
PASS  golden:node-soup.mock.json         match
UNVERIFIED — HUMAN  summary-human-mean-min (no ratings file)
```

`pnpm bench` (AI rows from the complete root bench chain):

```text
PASS  ai-replay-overhead-p50-ms  0.030  (budget ≤ 5 ms)
PASS  ai-replay-overhead-p95-ms  0.051  (budget ≤ 5 ms)
PASS  ai-cluster-5k-compute-ms  229.3    (budget ≤ 2000 ms)
```

## Record/replay status

The record command is implemented and wired to `recordSession`:

```sh
ANTHROPIC_API_KEY=… node evals/run.mjs --record anthropic claude-opus-4-8 \
  --task summarize --consent-live
OPENAI_API_KEY=… node evals/run.mjs --record openai text-embedding-3-large \
  --task cluster --consent-live
node evals/run.mjs --replay
```

Provider, model, task, literal consent, matching key, and non-CI execution are
validated before a real session is built. Each successful task run atomically
merges its snapshot into `evals/recordings/services.recording.json`, persists
usage/pricing metadata, and writes an inspectable/rateable output under
`evals/out/`. Replay meters recorded usage deterministically but performs no
provider call and incurs no new external charge.

`services.recording.json` is intentionally absent today. Therefore the command-
line full **live** replay remains UNVERIFIED. `pnpm test:evals` proves the exact
writer/merge/replay format offline in a temporary directory and never fabricates
a live recording.

## Cost table

[docs/ai-cost-table.md](../ai-cost-table.md) contains the provider-neutral
measurement method. Every provider/model result row remains **UNVERIFIED — needs
live record**. Reference catalog prices are method inputs, not measured costs.

## Definition of Done

- [x] **Offline gateway and service suites pass:** AI 88/88; AI services 55/55.
- [x] **CLI AI surface exists and passes:** 13/13 AI tests (320/320 full CLI).
- [x] **Studio trust surface passes:** 20 focused unit tests and 6/6 Playwright AI E2E tests.
- [x] **Zero-network record → replay is proven:** `pnpm test:evals` writes both tasks to temporary durable output, blocks fetch, and replays green.
- [x] **Offline eval floors and goldens pass.**
- [x] **AI perf contracts are wired into `pnpm bench` / `pnpm ci` and pass.**
- [x] **Provider-agnostic architecture is enforced:** Anthropic and OpenAI adapters, configuration routing, SDK confinement.
- [x] **Eval/rating instructions and cost-measurement method are documented.**
- [ ] **Live recordings authored:** Anthropic summary, OpenAI summary, and OpenAI embedding fixtures. UNVERIFIED; requires keys, consent, network, and spend.
- [ ] **P7 fixture repo replayed through `meridian ai summarize` in CI.** The CLI exists, but it does not yet consume a committed live P7 recording.
- [ ] **5k-node embedding + clustering `<10 s` live/nightly.** Offline compute passes; provider round-trip is UNVERIFIED.
- [ ] **20 real summaries meet the human-rating floor.** UNVERIFIED — HUMAN; no ratings file.
- [ ] **Measured cost rows filled.** All live rows remain UNVERIFIED.
- [ ] **ADR-0032 accepted.** Per-project cumulative budgeting is not embodied; only the per-session guard is implemented.
- [ ] **Gate closed by user:** after the unchecked live/human/policy rows are resolved, the user may create `git tag phase-8`.
