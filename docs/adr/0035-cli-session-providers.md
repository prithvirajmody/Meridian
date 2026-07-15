# ADR-0035 — CLI-session providers: Claude Code and Codex as subprocess-backed `AiProvider` adapters (no API key on the live path)

- **Status:** Accepted
- **Date:** 2026-07-15
- **Phase:** 8 (amendment)
- **Constitution:** ARCHITECTURE.md §8.2 (provider architecture — routing is configuration), §8.3 (gateway pipeline), §20 (dependency law); ADR-0029 (provider-agnostic gateway), ADR-0030 (record/replay determinism), ADR-0032 (budget policy)
- **Roadmap:** ROADMAP.md Phase 8 §3 ("env-based key config" — amended by this record), §10 (deferred list — clarified, not violated)

## Context

Phase 8's `live` mode reaches a vendor only through the two SDK adapters, each
requiring an API key from the environment (`ANTHROPIC_API_KEY` /
`OPENAI_API_KEY`). The project owner wants the live path to run against the
**locally installed, already-authenticated Claude Code and Codex CLIs**
instead: spawn a headless agent process per call, read its answer, kill it —
no API key handling in Meridian at all. Billing rides the user's existing
subscription; the key edge disappears from this repo's configuration surface.

This is *not* the deferred "local models" item (Phase 8 §10): the models are
the same cloud models; only the transport and auth change (vendor SDK + key →
vendor CLI + its own login). It is, however, an amendment to the Phase 8
deliverable text "env-based key config", so it is recorded here rather than
done silently. ADR-0029 already reserves exactly this slot: "new vendors …
are additive: a new adapter + a descriptor + a policy-table binding, no
gateway or service change."

## Decision

**Add two subprocess-backed provider adapters — `claude-cli` and `codex-cli` —
behind the unchanged `AiProvider` seam, and make `claude-cli` the default live
completion provider.** Concretely:

**1. Additive adapters, ADR-0029 intact.** The Anthropic and OpenAI SDK
adapters stay in the tree (they are the constructive proof of the seam and the
only embedding path). The CLI adapters are two new confined modules under
`packages/ai/src/providers/`:

- `claude-cli` — spawns `claude -p --output-format json --model <model>
  --max-turns 1` with tools disabled and the request's system prompt passed
  via `--system-prompt`; parses the JSON result envelope (`result`, `usage`,
  `total_cost_usd`, `is_error`).
- `codex-cli` — spawns `codex exec --json -m <model>` in read-only sandbox
  mode; parses the JSONL event stream for the final agent message and token
  counts.

Both are completion-only (`capabilities.embedding: false`). The `embedding`
task class keeps routing independently (OpenAI adapter or mock) — neither CLI
embeds. Services, session pipeline, cache, budget, and routing change **not at
all**; the CLI providers are new `providerId`s in the policy table.

**2. Process lifecycle: spawn per call, kill on abort.** One short-lived
process per completion request. The gateway's `AbortSignal` maps to SIGTERM
(SIGKILL after a short grace); a per-call wall-clock timeout kills the process
and surfaces as `provider_transient` (retryable under the existing backoff
policy). Non-zero exit, `is_error: true`, or an unparseable envelope normalize
to the existing `AiError` kinds — never a raw subprocess error. No process
pool and no `--resume` session reuse in v1: gateway calls are independent
completions, and per-call spawn/kill is the simplest correct lifecycle.

**3. Confinement: the runner is the new "SDK".** Adapter logic consumes an
injected `CliRunner` interface (spawn + kill + streams), mirroring how the SDK
adapters consume injected clients. Both CLIs share one impure edge, so a
single factory module (`cli-runner-client.ts`) is the only importer of
`node:child_process`; a dependency-cruiser confinement rule proves it,
alongside the existing SDK rule. All adapter behavior — arg construction, envelope parsing,
error normalization, kill-on-abort — is tested with a fake runner, zero
subprocesses, zero network, exactly like the injected-client tests today.

**4. Structured output via prompt + existing validation.** Headless CLIs have
no forced-tool mechanism, so when `outputSchema` is present the adapter
appends a strict "respond with only JSON conforming to this schema"
instruction carrying the JSON Schema, and parses the result text (tolerating a
fenced code block) into `structured`. The gateway contract is unchanged:
schema in, validated value or typed failure out — zod validation plus the
existing single repair attempt remain the correctness backstop (§8.3).

**5. Trust boundary unchanged.** A CLI session still egresses to the vendor's
cloud, so `claude-cli`/`codex-cli` are *live* providers: `--ai-consent` and
the gateway's `egressConsent` gate apply exactly as for SDK providers. `mock`
and `replay` stay zero-network and zero-subprocess. Record/replay needs no
change — cache keys already carry `(providerId, model, …)`, so CLI-provider
fixtures are ordinary new entries.

**6. Budget: notional metering.** The CLIs report real token usage; adapters
normalize it into `Usage` as today. Marginal dollar cost under a subscription
is $0, but a zero-price catalog would make every `maxDollars` ceiling
meaningless — so the CLI catalogs carry the vendors' **reference API prices**
and `BudgetGuard` meters *notional* spend (what the run would have cost at
API rates). The CLI-reported `total_cost_usd`, when present, is retained in
`raw` for diagnostics. Documented in the cost table as notional.

**7. Defaults.** `--ai-provider` accepts `claude-cli` and `codex-cli`. With no
explicit provider, live-mode completion routes default to `claude-cli`
(replacing `anthropic` as the default); embedding keeps its `openai` default
and now carries the only remaining key requirement, stated plainly in the
error when the key is absent. Missing CLI binary is a deterministic `config`
error naming the binary, symmetric with today's missing-key error.

## Alternatives considered

- **Replace the SDK adapters outright.** Rejected: ADR-0029's two built-in
  adapters are the in-tree proof of the provider seam, and the OpenAI adapter
  is the only embedding path. Removing them buys nothing — the default live
  route flipping to `claude-cli` already delivers "no API key" day-to-day.
- **Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) instead of raw
  subprocess.** Rejected for v1: it adds a vendor dependency, covers only one
  of the two CLIs, and its agentic session machinery exceeds what a one-shot
  completion needs. The raw-spawn `CliRunner` seam covers both CLIs uniformly
  with zero new dependencies. An Agent-SDK adapter remains an ordinary future
  adapter if streaming/session reuse is ever wanted.
- **Persistent warm sessions (`--resume` pool).** Deferred: saves process
  startup latency but adds pool lifecycle, cross-call state risk, and an
  idle-kill policy — none needed while calls are independent one-shots.
- **Treating CLI providers as zero-network ("it's local").** Rejected: the
  process is local, the inference is not. Consent gates stay.
- **Zero-price catalogs.** Rejected: silently disables every budget ceiling
  (ADR-0032's hard-stop semantics would never fire). Notional reference
  pricing keeps budgets binding and cost reports comparable.

## Tradeoffs & consequences

Buys a keyless live path on existing subscriptions, agent spawn/kill lifecycle
under the gateway's existing abort/retry discipline, and a third+fourth
in-tree exercise of the provider seam. Costs: per-call process startup latency
(seconds, acceptable for enrichment jobs); structured output rides prompt
discipline + validation instead of a vendor-native mechanism (the repair path
absorbs the difference); budget dollars become notional for CLI routes; local
environments must have the CLIs installed and logged in (CI never does —
replay only, unchanged). `packages/ai` gains a confined `node:child_process`
edge, matching the confined-SDK precedent.

## Reasoning

The whole point of ADR-0029's seam is that "which vendor mechanism answers a
completion" is an adapter detail. A subprocess speaking a CLI's JSON envelope
is no different in kind from an HTTPS client speaking a REST dialect: four
surfaces (structured output, usage, stop reasons, errors) normalize behind the
adapter, and everything above stays vendor-blind. The only genuinely new
architectural matter — a process lifecycle inside `packages/ai` — is tamed the
same way the SDKs were: confine the impure edge to one factory module per
binary, inject it, and test everything against fakes.

## Future implications

Streaming, warm session pools, and an Agent-SDK-based adapter are additive
follow-ups behind the same seam. If a true local-model runtime (the deferred
item) ever ships, it arrives as another `ai-provider` plugin and inherits this
record's runner-confinement pattern. The notional-pricing stance generalizes
to any subscription-billed provider.
