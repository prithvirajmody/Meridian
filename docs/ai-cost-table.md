# AI cost table — ¢ per 1k nodes (measured)

ROADMAP Phase 8 §13 (Definition of Done) requires a **measured** cost table
committed to the docs: cents per 1,000 nodes summarized (and clustered), per
provider/model. This file defines the **measurement method** and holds the
result rows.

> **Status: rows UNVERIFIED.** The measured numbers require the live `--record`
> path (a real vendor call, a real key, real money) and are **not** filled in
> yet. Every provider/model row below is marked **UNVERIFIED — needs live
> record**. The reference per-token prices in
> `packages/ai/src/catalogs.ts` are the vendors' own **indicative** list prices
> and are explicitly *not* a measured cost — they are shown here only as the
> multiplier the method plugs measured token counts into. **No price in this
> file is invented, and no cost cell is filled from memory.**

## Why the numbers aren't here yet

The offline eval, fake record→replay test, and perf benches run with
`MockProvider`s and zero network (ADR-0030), so they exercise the *plumbing* and
*token accounting* but never call a vendor. A real ¢/1k-nodes figure needs actual `Usage`
(input/output/cached tokens) from a live provider response, which only the
consent-gated record path produces:

```sh
ANTHROPIC_API_KEY=… node evals/run.mjs --record anthropic claude-opus-4-8 \
  --task summarize --consent-live
OPENAI_API_KEY=… node evals/run.mjs --record openai gpt-4.1 \
  --task summarize --consent-live
OPENAI_API_KEY=… node evals/run.mjs --record openai text-embedding-3-large \
  --task cluster --consent-live
```

This path is the only one that spends money or touches the network; it never
runs in CI (evals/README.md §3). Until a human runs it, the rows stay
UNVERIFIED.

## Measurement method (provider-neutral)

Cost is computed the same way for every provider — the gateway normalizes each
vendor's usage into one `Usage` shape, and one pure function turns usage +
per-model price into dollars. Nothing here is provider-specific.

1. **Token accounting.** Every gateway call returns
   `AiResult.usage: { inputTokens, outputTokens, cachedInputTokens? }`
   (`packages/ai/src/types.ts`), normalized identically by the Anthropic and
   OpenAI adapters (ADR-0029). Replay hits commit the stored usage through the
   same `BudgetGuard`, producing deterministic *nominal* spend without a provider
   call or a new external charge; ordinary live-cache hits are free. The optional
   `cachedInputTokens` field is retained for diagnostics, but v1 `ModelPricing`
   has no separate cached-input price and the record driver does not enable vendor
   prompt-cache controls.
2. **Cost of one call.** `costOf(usage, pricing)`
   (`packages/ai/src/budget.ts`, unit-tested by
   `packages/ai/test/budget.test.ts` → *"computes dollars from usage and
   pricing"*) computes
   `dollars = inputTokens/1e6 · inputPerMTok + outputTokens/1e6 · outputPerMTok`
   where `pricing = { inputPerMTok, outputPerMTok }` in USD per 1,000,000
   tokens (`ModelPricing`, `packages/ai/src/catalogs.ts`). This is the SAME
   accounting the live `BudgetGuard` uses — the cost table and the budget
   ceiling read from one code path, so they cannot disagree.
3. **Per-1k-nodes normalization.** Run a service over a fixture of known node
   count `N` in `--record` mode, sum `costOf(...)` across every call it makes,
   then report `¢/1k = (Σ dollars · 100) / N · 1000`.
   - `summarizeCut` — N = the 20 real Meridian modules in
     `evals/fixtures/module-summaries.json` (one completion per rollup).
   - `clusterNodes` — N = the 500-node soup (`evals/fixtures/node-soup.mjs`);
     one embedding batch + pure k-means (the clustering compute itself is free;
     only the embedding tokens cost money).
4. **Provider swap is config.** Because provider/model is routing
   configuration (ADR-0029), the identical fixture and identical `costOf`
   accounting produce each row below — only the `--record <provider> <model>
   --task …` routing arguments and the per-model price change.

The method is committed and testable now; only the token counts in the last
column await a live run.

## Result rows — UNVERIFIED (needs live record)

Reference price columns are the vendors' indicative list prices from
`packages/ai/src/catalogs.ts` (USD per 1M tokens) — shown as the method's
multiplier, **not** a measured cost. The measured ¢/1k columns are what a live
`--record` run fills in.

### `summarizeCut` (completion — names + summaries)

| Provider | Model | Ref input $/MTok | Ref output $/MTok | Measured ¢ / 1k modules |
|---|---|---|---|---|
| Anthropic | `claude-opus-4-8` | 15 | 75 | **UNVERIFIED — needs live record** |
| Anthropic | `claude-haiku-4-5` | 1 | 5 | **UNVERIFIED — needs live record** |
| OpenAI | `gpt-4.1` | 2 | 8 | **UNVERIFIED — needs live record** |

### `clusterNodes` (embedding — vectors only, clustering compute is free)

| Provider | Model | Ref input $/MTok | Ref output $/MTok | Measured ¢ / 1k nodes |
|---|---|---|---|---|
| OpenAI | `text-embedding-3-large` | 0.13 | 0 | **UNVERIFIED — needs live record** |

(Anthropic ships completion-only in the reference catalog — no embedding row.)

## How to fill this in

1. Run the relevant `--record` command above with a real key for each row (and
   repeat the summary command with `claude-haiku-4-5` for that row).
2. Read the calls/tokens/dollars and ¢/1k value printed by the record run. The
   same usage is persisted in the task's recording metadata; inspectable outputs
   land in `evals/out/<fixture>.<provider>.<model>.json`.
3. Replace each **UNVERIFIED** cell with the computed ¢/1k value, note the
   fixture commit and the date, and — only then — check the cost-table row in
   [phase-08.md](checklists/phase-08.md).

Until then this table is honest about being empty: the *method* is verified,
the *prices* are the vendors' indicative list, and the *measured costs* do not
exist yet.
