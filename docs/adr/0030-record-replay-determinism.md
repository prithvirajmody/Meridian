# ADR-0030 — Record/replay determinism: content-hash cache keyed by (providerId, model, promptVersion, inputHash), zero-network CI, live calls gated by consent

- **Status:** Accepted
- **Date:** 2026-07-13
- **Phase:** 8 (roadmap)
- **Constitution:** ARCHITECTURE.md §8.3.1 (consent check), §8.3.2 (cache = record/replay store, CI cache-miss is a test failure), §19.3 (data-egress consent); ADR-A5
- **Roadmap:** ROADMAP.md Phase 8 §3, §7, §8 (ADR-0030), §11, §12
- **Related:** ADR-0029 (the seam whose calls are recorded), ADR-0031 (provenance carries the same key fields)

## Context

AI is nondeterministic and metered; the constitution makes AI-dependent behavior
testable by running CI in **replay mode against a content-addressed cache where a
miss is a test failure, never a network call** (§8.3.2). Phase 8 must build that
discipline before the first real API call exists (§ subphase ordering: gateway +
MockProvider before any provider; providers before services). With ADR-0029
promoting AI to a **multi-provider** seam, the cache key must distinguish vendors
and models — otherwise an Anthropic-recorded fixture could silently satisfy an
OpenAI-routed call, hiding exactly the provider divergence the two built-ins exist
to expose. This record fixes the key, the session modes, and the consent gate on live
egress.

## Decision

**One durable, content-addressed store doubles as cache and record/replay
fixtures.** Entries are keyed by the tuple:

`replayIdentity = (providerId, model, promptVersion, inputHash)`

- **`providerId`** — the routed provider adapter (ADR-0029). In the key because a
  provider swap must be a cache miss: the same prompt through Anthropic vs OpenAI
  is a different fact and must record separately.
- **`model`** — the routed model id. Different model, different fixture (a model
  bump is a deliberate re-record, not a silent reuse).
- **`promptVersion`** — the `PromptSpec` version (prompts are versioned files, not
  literals — ROADMAP §7). Editing a prompt invalidates its fixtures.
- **`inputHash`** — a **canonical** hash of the rendered request payload (rendered
  prompt + params + schema identity + relevant request options), serialized with
  stable object-key ordering. Whitespace *inside prompt or input strings remains
  semantic* and is not rewritten. Embeddings hash their model + ordered input text
  batch the same way.

The tuple is exactly the identity later stamped onto AI provenance (ADR-0031), so a
node's origin fields reproduce the call that made it.

The physical `ResponseKey` also includes `kind`, `promptId`, and
`attempt: primary|repair`. These are collision guards for completion vs embedding,
two prompt specs that happen to share a version, and the one repair round-trip;
they refine the store key without changing the provenance identity above.

**Four session modes, one switch.** `off` calls the configured provider without
reading or writing the store; `live` is cache-through; `record` always calls the
provider and overwrites the addressed entries so fixture refresh is explicit; and
`replay` is read-only. In replay the store is authoritative: a cache **miss is a
test failure**, never a fallback to the network.

**CI defaults to zero-network replay.** No CI job may reach an AI vendor. The
replay-overhead budget is `< 5ms/call` (ROADMAP §12 Performance). Recorded fixtures
are locked with their prompt versions in the regression suite (ROADMAP §12
Regression).

**Live calls require explicit consent.** Any possible egress — reachable in `live`
or `record` mode — passes the §8.3.1 consent check first. The v1 `AiSession`
conservatively requires `egressConsent: true` for both modes regardless of provider;
the eval CLI additionally requires the literal `--consent-live` flag and the
matching environment key. A verifiably-local-provider bypass is deferred until the
gateway has a trustworthy locality descriptor. No consent means no session and no
call; replay never grants or needs consent.

**Durable fixture boundary.** The package store is isomorphic and in-memory;
fixture drivers serialize its plain-JSON snapshot. Phase 8's eval driver writes
`evals/recordings/services.recording.json` atomically, merges independently
recorded summarization and embedding tasks, and writes inspectable outputs under
`evals/out/`. Consent itself and API keys are never serialized.

**Determinism envelope.** Replay reproduces the recorded *response*, so downstream
behavior is deterministic regardless of vendor sampling. Sampling parameters
(temperature etc.) that were in effect are part of the request payload and thus of
`inputHash`; changing them is a re-record. The store is durable and committed —
it is the fixture set, versioned with the code.

## Alternatives considered

- **Key without `providerId`/`model`.** Rejected: a fixture recorded on one
  vendor/model would satisfy a call routed to another, hiding provider divergence —
  the precise failure two built-in providers (ADR-0029) exist to catch.
- **Raw (non-canonical) input hashing.** Rejected: incidental object-key order would
  fork keys, causing spurious replay misses and fixture bloat. Prompt/input string
  bytes are intentionally preserved because changing them may change the response.
- **CI falls back to a live call on miss.** Rejected outright by §8.3.2: it
  reintroduces nondeterminism, cost, and network flakiness into CI and defeats the
  whole record/replay bet.
- **Seed-based reproducibility instead of caching.** Rejected: vendor sampling is
  not reproducibly seeded across versions or providers; recording the actual
  response is the only portable determinism.
- **Ephemeral cache (not committed).** Rejected: then CI has nothing to replay; the
  cache *is* the fixture store, so it must be durable and versioned.

## Tradeoffs & consequences

Buys deterministic, offline, zero-cost CI over all AI paths and a fixture set that
travels with the code. Costs: fixtures are per-`(provider, model, promptVersion)`,
so a provider/model/prompt change requires a local/nightly re-record (a deliberate,
reviewable act) and grows the store; canonicalization logic must be exact and
stable. Normalized provider *results*, including refusal stop reasons and raw
diagnostics, can be recorded. Thrown transport errors are exercised with injected
fake clients rather than serialized as successful cache entries.

## Reasoning

§8.3.2 already commits the cache-as-fixtures, miss-is-failure design; the only new
force is ADR-0029's multiplicity, which the `providerId` + `model` key elements
absorb. Consent-gating live egress (§8.3.1/§19.3) makes "CI never calls" true by
construction rather than by convention: CI never grants consent, so it can only
use mock/replay paths. Canonicalizing `inputHash` keeps object serialization stable
while preserving meaningful prompt/input bytes.

## Future implications

Every future provider (local models, new vendors) records under its own
`providerId`, so adding one cannot poison existing fixtures. P9's cacheable AI
enrichment passes and P12 agents inherit the same store and mode switch unchanged.
The eval harness (subphase 8F) reads the same fixtures; eval floors are computed
offline against replay. If a future provider is verifiably local, an additive,
auditable locality descriptor may permit its record-mode calls to skip remote-
egress consent while still populating the same store; v1 deliberately does not
guess locality.

## Resolved implementation decisions (2026-07-13)

1. **Canonicalization scope:** completion hashes the rendered system/messages,
   routed model, output schema, output-token cap, temperature, and stop sequences;
   embeddings hash the routed model and ordered text batch. Provider transport-only
   controls do not cross the neutral request seam and therefore are not hashed.
2. **Fixture location and replacement:** the full-service snapshot lives at
   `evals/recordings/services.recording.json`. Each `--record --task ...` run
   atomically replaces that task's entry while preserving the other task, so stale
   entries for the refreshed task are pruned as a unit. No live recording is
   committed until a human explicitly authors one.
