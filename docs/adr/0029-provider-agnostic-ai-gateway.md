# ADR-0029 — Provider-agnostic AI gateway: one `AiProvider` seam, Anthropic and OpenAI as first-class built-in adapters, routing is configuration

- **Status:** Accepted
- **Date:** 2026-07-13
- **Phase:** 8 (roadmap)
- **Constitution:** ARCHITECTURE.md §8.1 (AI trust boundary), §8.2 (provider architecture — "routing is configuration, not code"), §8.3 (gateway services), §8.4 (service catalog), §20 (dependency law); ADR-A5 (AI as optional enhancement behind proposals — this is one of its reserved ADRs, `ADR-0029/0031`)
- **Roadmap:** ROADMAP.md Phase 8 §3, §4, §5, §8 (ADR-0029), §12 (Architecture row)

## Context

Phase 8 builds `@meridian/ai`, the gateway between AI services and AI vendors.
The constitution already fixes the shape (§8.2): the `ai-provider` capability
abstracts vendors, routing is a task-class policy table resolved from
configuration, "multiple providers coexist", and Anthropic is named only as a
*reference configuration* — "not an architectural commitment". Earlier roadmap
text (§3, the AI stack row) read as if Anthropic were **the** implementation and
"only `ai` imports the Anthropic SDK" were the architecture. That drift makes the
vendor look load-bearing when the constitution says the *seam* is. This record
commits the seam concretely, promotes **two** vendors to first-class built-in
adapters so provider-agnosticism is proven by construction rather than asserted,
and fixes exactly what is configuration versus code. It does **not** change any
Phase 8 outcome, subphase ordering, or Definition of Done — it makes the existing
constitutional stance implementable and testable.

## Decision

**The `AiProvider` interface is the only architectural commitment; every vendor is
an interchangeable adapter behind it.** Concretely:

**Two first-class built-in providers.** v1 ships **two** provider adapters in the
tree, on equal footing: an **Anthropic** adapter and an **OpenAI** adapter, each
under `packages/ai` (see confinement below). Neither is privileged in the
architecture; either can serve any task role. A local-model / third-party provider
remains an expected `ai-provider` *plugin* (§8.2), unchanged. Shipping two proves
the seam holds; one vendor could always be special-cased by accident.

**Provider selection and task-role routing are configuration, not service logic.**
The gateway routes each call by a **task-class policy table** (§8.2): task roles
(`extraction`, `summarization`, `bulk-label`, `embedding`, …) → `(providerId,
modelId)`, with per-project overrides. Services name a **task role**, never a
vendor or a model. Which provider and model answer a role is resolved from config
at call time. Swapping Anthropic↔OpenAI for a role, or pointing a role at a plugin
provider, is a config edit — no service code changes.

**Model IDs are configuration, never service logic.** `claude-opus-4-8`,
`claude-haiku-4-5`, an OpenAI model id, etc. are values in the policy table, not
constants in services or in the gateway core. The v1 capability descriptor
contains completion/embedding support and a model-to-price catalog; the router
reads that descriptor and does not hard-code model names. Context-window and
batch/cache capability metadata remain additive future descriptor fields.

**Embeddings route independently.** Completion and embedding are separate task
routes with independent `(providerId, modelId)` bindings: the embedding provider
may differ from every completion provider (the core needs only vectors, §8.2 /
ROADMAP §3). `AiProvider` exposes `complete` and an optional `embed`; a provider
declares whether completion and embedding are supported, and configuration
validation rejects a route whose declared capability is absent.

**Adapters normalize the four vendor-divergent surfaces into gateway-neutral
shapes.** Behind the seam, each adapter maps its SDK's dialect to one internal
vocabulary:
- **Structured output** — the gateway hands the adapter a schema (P4/zod); the
  adapter uses whatever native mechanism its vendor offers and returns parsed,
  schema-valid data or a typed failure. The gateway's contract is "schema in,
  validated value or typed failure out" — never a vendor request field.
- **Usage** — normalized to `{ inputTokens, outputTokens, … }` regardless of the
  vendor's accounting field names, so `BudgetGuard` (ADR-0032) and the cost table
  are vendor-neutral.
- **Stop reasons** — normalized to the closed gateway enum
  `stop | max_tokens | tool_use | stop_sequence | refusal | content_filter |
  other`; refusal and truncation are the same typed outcomes to services
  whichever vendor produced them.
- **Errors** — normalized to typed gateway failures (rate-limit, overloaded,
  transient-network, invalid-request, refusal, budget) so resilience (§8.3.5) and
  backoff (ADR-0030/0032) are written once against the enum, not per vendor.

**SDK imports are confined to their provider adapters inside `packages/ai`.** Each
vendor SDK (`@anthropic-ai/sdk`, `openai`, an embedding-vendor SDK) is imported
**only** by its own adapter module within `packages/ai`; the gateway core
(session pipeline, cache, budget, router, consent) and every other package import
**no** vendor SDK. `ai-services` depends on `ai` and core seams only. Enforced by
dependency-cruiser as a CI gate (§20): the rule targets the adapter files, not the
`ai` package as a whole, so adding OpenAI does not widen the surface — it adds a
second confined adapter.

**Vendor mechanisms are adapter examples, never commitments.** In v1 the neutral
completion request carries an optional JSON Schema. Anthropic fulfills it with a
forced tool input; OpenAI fulfills it with `json_schema` response format (strict
when the schema subset permits, otherwise non-strict followed by the same gateway
validation). Batch APIs and vendor prompt-cache controls are deliberately not on
the v1 seam; adding them requires an additive capability decision rather than
leaking either vendor's request vocabulary upward.

## Alternatives considered

- **Single built-in vendor (Anthropic only), others as plugins.** Rejected: with
  exactly one built-in provider the seam is never exercised in-tree, so vendor
  assumptions leak in as "conveniences" (the §22-risk-8 waist erosion). Two
  built-ins make provider-agnosticism a test, not a promise.
- **Provider/model choice in service code (`if provider === …`).** Rejected:
  reintroduces vendor coupling the constitution forbids; makes routing untestable
  as configuration; breaks per-project overrides.
- **One `AiProvider` per (vendor × model).** Rejected: conflates the vendor seam
  with model selection; the descriptor already carries the model catalog, and the
  router binds models per role.
- **Shared embedding route piggybacking on the completion provider.** Rejected:
  the best embedding vendor is routinely not the best completion vendor; an
  independent route costs nothing and the core needs only vectors.
- **Leaking vendor request/response types through the gateway.** Rejected: any
  vendor field on the gateway surface is a de-facto commitment; normalization at
  the adapter boundary is the whole point of the seam.

## Tradeoffs & consequences

Buys genuine provider independence (proven by two built-ins, not asserted),
config-only vendor/model swaps, per-project routing, and a single normalized
vocabulary for budget/resilience/eval to target. Costs: a normalization layer per
adapter (four surfaces × two vendors) and the discipline that the gateway core
stays vendor-blind; two SDKs vendored instead of one. The record/replay store
(ADR-0030) keys on `providerId` + `model`, so fixtures are per-provider — accepted,
and exactly what makes a provider swap observable in CI.

## Reasoning

§8.2 already says the seam is the commitment and routing is configuration; the
only defensible way to *hold* that line is to build two vendors against it from day
one and mechanically forbid vendor SDKs outside their adapters. Everything a
service needs — structured output, usage, stop reasons, errors — is expressible in
vendor-neutral terms, so nothing forces a vendor type onto the gateway surface.
Model ids and provider choice are values that change with cost and availability;
values belong in configuration, not in code (§8.2).

## Future implications

New vendors (local models, future entrants) are additive: a new adapter + a
descriptor + a policy-table binding, no gateway or service change (ADR-A5's "F:
provider market shifts are configuration"). The normalized stop-reason and error
enums let P9 hybrid adapters and P12 agents inherit resilience unchanged. The
capability descriptor is the extension point for future task classes (relationship
inference, contradiction analysis, §8.4) without touching the seam.

## Resolved implementation decisions (2026-07-13)

1. **Second built-in vendor:** OpenAI ships alongside Anthropic and both adapters
   are exercised by injected-client tests.
2. **Embedding binding:** OpenAI is the built-in provider with embedding support,
   but the gateway has no implicit vendor default; every session binds the
   `embedding` route explicitly in configuration.
3. **Descriptor granularity:** v1 advertises completion, embedding, and model
   pricing only. Structured output is part of the neutral completion contract and
   remains gateway-validated. Batch and prompt-cache capability negotiation is
   deferred rather than represented by flags that no current caller implements.
