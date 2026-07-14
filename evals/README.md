# Meridian evals

Offline-first, provider-neutral quality harness for the Phase 8 AI services
(`@meridian/ai-services` over the `@meridian/ai` gateway). It scores the two
services with measurable outputs — `summarizeCut` (module summaries) and
`clusterNodes` (a 500-node flat soup) — against regression floors and byte-stable
goldens.

The model-quality gate itself is **not** part of `pnpm test` or `pnpm bench`;
run it on demand and on model/prompt changes. CI does run the small
`pnpm test:evals` infrastructure test: it records with in-process fake providers
into a temporary directory, blocks network access, then proves the resulting
snapshot replays green. No human/model quality is inferred from that fake run.

## Prerequisites

The harness imports the built packages directly (like `benchmarks/`), so build
first:

```sh
pnpm --filter @meridian/ai build
pnpm --filter @meridian/ai-services build
# or: turbo run build
```

No API key and no network are needed for the default and replay paths.
`pnpm test:evals` performs its own build first.

## The three paths

### 1. Offline (default) — the gate

```sh
node evals/run.mjs
```

Deterministic `MockProvider`s, zero network. Proves the plumbing and
determinism and gates on the objective floors + goldens. This is what a
reviewer runs to confirm the harness is healthy. Exits non-zero on any
regression.

### 2. Replay — CI-style

```sh
node evals/run.mjs --replay
```

Loads a committed recording (`evals/recordings/services.recording.json`) and
replays it with the network disabled — a cache miss is a hard error (ADR-0030).
Replay commits the fixture's recorded usage to `BudgetGuard` so budget state is
deterministic, but it makes no provider call and incurs no new vendor charge.
A full recording needs both a `summarize` and a `cluster` entry. Live recordings
are absent until a human authors them with the path below.

### 3. Live / record — the human step (needs keys)

```sh
ANTHROPIC_API_KEY=… node evals/run.mjs --record anthropic claude-opus-4-8 \
  --task summarize --consent-live

# OpenAI can be used for summaries instead:
OPENAI_API_KEY=… node evals/run.mjs --record openai gpt-4.1 \
  --task summarize --consent-live

# The 500-node clustering fixture needs an embedding-capable provider:
OPENAI_API_KEY=… node evals/run.mjs --record openai text-embedding-3-large \
  --task cluster --consent-live
```

The literal `--consent-live` flag and the matching provider key are both required;
the command also refuses to run when `CI` is set. Provider/model selection is
configuration: record summaries with either Anthropic or OpenAI, then record
clusters with an embedding-capable provider. Each task run atomically replaces
its entry in `evals/recordings/services.recording.json` while preserving the other
entry. It also writes inspectable output to
`evals/out/<fixture>.<provider>.<model>.json` and reports calls, tokens, dollars,
and cents per 1,000 fixture units. Consent and keys are never persisted.

This is the only eval path that spends money or touches the network; it never
runs in automated tests.

## Offline record → replay proof

```sh
pnpm test:evals
```

This test uses deterministic `MockProvider`s, writes both task artifacts under a
temporary directory, replaces `fetch` with a throwing sentinel, and evaluates
the durable output in replay mode. It proves the record writer, merge format,
hard replay misses, and objective floors without a key or network.

## What is gated vs. what is human

| Signal | How measured | Gate |
|---|---|---|
| Cluster purity / ARI | vs. the soup's known latent topics (objective) | `cluster-purity-min`, `cluster-ari-min` |
| Summary structural validity | schema + grounding checks (objective) | `summary-structural-valid-min` |
| Determinism | run-twice byte equality (objective) | must be `true` |
| Mock goldens | byte-stable diff (objective) | must `match` |
| **Summary quality** | **human rating (RUBRIC.md)** | `summary-human-mean-min`, only when `ratings/…json` exists |

Human ratings are never fabricated. Until a human records real summaries and
rates them, the quality row reports **UNVERIFIED — HUMAN**.

The Phase 8 gate mapping of every ROADMAP §12 row to its command + evidence
(and which rows are still UNVERIFIED) lives in
[`docs/checklists/phase-08.md`](../docs/checklists/phase-08.md); the measured
cost table (§13) and its measurement method are in
[`docs/ai-cost-table.md`](../docs/ai-cost-table.md).

## Golden format & regen

Goldens live in `evals/goldens/` and change only via the documented command
(CLAUDE.md hard rule):

```sh
node evals/run.mjs --update-golden
```

- `module-summaries.mock.json` — the deterministic mock name/summary/confidence per module.
- `node-soup.mock.json` — cluster count, purity, ARI, and per-cluster labels.

## Floors

`evals/floors.json` — minimums; a value below its floor fails the run. Floors
ratchet up, never down (mirrors `benchmarks/budgets.json` discipline).

## Layout

```
evals/
  run.mjs                 # entrypoint (mock | --replay | --record | --update-golden)
  floors.json             # regression floors
  RUBRIC.md               # human rating rubric (summaries)
  lib/                    # prng, metrics, mock providers, session builders
  test/                   # zero-network fake record → replay proof
  fixtures/
    module-summaries.json # 20 real Meridian modules + human-authored reference anchors
    node-soup.mjs         # deterministic flat-soup generator (buildSoup)
  goldens/                # committed mock goldens (regen: --update-golden)
  ratings/                # human ratings (example template committed; real file gates)
  recordings/             # live-recorded replay fixtures (produced by --record)
  out/                    # inspectable/rateable live outputs (--record; git-ignored)
```
