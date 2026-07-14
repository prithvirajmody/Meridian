# ADR-0034 — Hybrid adapter pattern: deterministic skeleton + separately-cacheable AI enrichment passes

- **Status:** Accepted
- **Date:** 2026-07-14
- **Phase:** 9 (roadmap)
- **Constitution:** ARCHITECTURE.md §7.1 (parsers: source in, IR out, no store references), §7.2 (lifecycle — skeleton pass then optional enrich passes; "skeleton = truth, enrichment = suggestion"), §7.3 (conversations = reference two-pass; arguments = enrichment-reliant with a sentence-level floor), §8.1 (deterministic floor; AI writes only via proposals; always filterable), §8.3 (gateway's non-negotiable services), P6 (AI is enhancement, never dependency), P8 (semantics pure), P10 (provenance everywhere); ADR-A5
- **Roadmap:** ROADMAP.md Phase 9 §1, §3 (skeleton parsed deterministically, AI layered on top; argument keeps an AI-less degraded skeleton), §7 (node/edge kinds; level chains via manifests), §8 (ADR-0034), §11, §12 (Failure cases — AI unavailable → degraded-but-working skeleton)
- **Related:** ADR-0005 (the sole store write path proposals resolve into), ADR-0029 (provider-neutral gateway seam enrichment calls through), ADR-0030 (replay keys — the same tuple that makes enrichment idempotent), ADR-0031 (proposals-only writes; additive provenance), ADR-0032 (budget hard-stop leaves valid partial state), ADR-0033 (the seam is not widened for AI)

## Context

Phase 9's two adapters cannot exist without Phase 8, yet the constitution
forbids AI from being load-bearing (P6, §8.1): every feature must work,
degraded, with no provider. §7.2 already names the resolution — a
**deterministic skeleton pass** ("truth") plus **optional AI enrichment
passes** ("suggestion"), separately cacheable and re-runnable — and calls it
"the platform's standard pattern for AI-native domains." Conversations are its
reference implementation; arguments push it hardest, leaning most on
enrichment while still owing a deterministic floor (§7.3).

This record fixes that pattern as *the* recommended shape for AI-native
adapters: where the skeleton lives, where enrichment lives, how they cache and
stay idempotent, and how they behave when AI is absent — without widening the
plugin contract (ADR-0033) or opening a second write path (ADR-0005).

## Decision

**The skeleton is an ordinary `DomainParser`.** Each adapter's deterministic
half is a normal parser in `packages/adapters/<domain>` that imports **only**
`plugin-api` (§20). It owns source-format and vocabulary knowledge, emits IR
carrying source provenance, is **byte-deterministic and AI-free**, registers
its level chain via its manifest, passes the conformance kit (§7.4), and
remains fully usable **with no provider, consent, key, network, cache, or
budget** — the degraded mode is the foundation, not a fallback bolted on. For
conversations, the Claude and ChatGPT export parsers are tiny isolated
per-format modules with their own fixtures (ROADMAP §9c). For arguments, the
skeleton floor is deterministic paragraph and sentence structure — the adapter
produces a real, zoomable map even if no model is ever called.

**Enrichment is a separate job outside the adapter package.** Optional
enrichment is owned by an **application composition root** (`apps/*`) or a
**separately chartered orchestration layer whose dependency law is explicitly
reviewed** to permit AI — never inside `adapters/<domain>`. It is **not**
located in `packages/plugin-host`: under the current dependency law
`plugin-host` may import only `plugin-api` and `zod`, so it may neither
orchestrate AI nor submit store writes. It reads the *accepted* skeleton,
invokes **provider-neutral `ai-services`** through the Phase 8 gateway
(ADR-0029), and **emits proposals only**:
- Topic grouping may use `AbstractionProposal` (the existing P3 rollup seam).
- Extracted claims, premises, objections, and typed relations
  (`arg:supports|rebuts|assumes|cites`, `conv:about|refers-back`) use
  `GraphProposal`.

Acceptance validates vocabulary, endpoint existence, identity collisions,
provenance completeness, and graph invariants **before** submitting one or
more ordinary **atomic deltas** through the sole store write path
(ADR-0005/0031); that **final store submission remains application-owned**, not
delegated to `plugin-host` or any adapter. The `plugin-api` is **not** widened to let an adapter call AI
or hold a store reference (ADR-0033); enrichment reaches the gateway from the
composition root, not from behind the parser capability. Human review is the
default; **auto-accept is explicit, per-project and per-service** (ADR-0031,
§8.1.2). The pattern is **not** locked to a specific public helper name, nor
to CLI-only enrichment: Studio may trigger or consume enrichment, but only
through the **same** gateway consent, replay, budget, proposal, and trust
boundaries, and provider work must never block the UI (§1.3 Intelligence —
asynchronous, cancellable, budget-interruptible).

**Skeleton and each enrichment service are separately cacheable.** The
skeleton caches on its deterministic inputs; each enrichment service caches
independently. AI calls key on the ADR-0030 tuple
`(providerId, model, promptVersion, inputHash)` — completion and embedding
routes independently (ADR-0029). Topic labeling, claim extraction, and
relation inference are distinct cacheable passes, refreshable one at a time.

**Idempotency is by stable coordinates, never by identity poisoning.**
Idempotency is **not** achieved by placing model or provenance into element
identity (that would fork IDs and duplicate on re-run — ADR-0031/0002).
Instead, accepted enrichment uses **stable domain coordinates anchored to the
skeleton** (a message/exchange/paragraph) or to **evidence spans**. An exact
re-run with the same `inputHash` is a **no-op**; a *changed* enrichment
**updates or replaces** the prior derived structure through deltas rather than
duplicating it (ROADMAP §9c "idempotent merge", §12 Unit). Every accepted nonempty AI structure
carries `origin:'ai'` and the **reproducible quartet** the current
`GraphProposal` supplies at call level (`providerId, model, promptVersion,
inputHash` — ADR-0031), so each AI fact names the call that made it and is
globally filterable. Per-node/edge `confidence` is **not** carried by every
`GraphProposal` today; it is recorded **only where a service actually supplies
it**, and must not be assumed present.

**Failure never touches the skeleton.** Provider unavailability, refusal,
replay-miss handling, cancellation, and budget exhaustion **never invalidate
or remove the deterministic skeleton**, and already-accepted partial
enrichment stays valid and clearly marked (ADR-0032's valid-partial-state
invariant). The two failure regimes are distinct:
- In **replay mode**, a cache miss is a **hard consistency failure** (a test
  failure, never a network fallback — ADR-0030/§8.3.2).
- In normal operation, a provider or budget failure **degrades to
  skeleton-only** behavior, per the gateway's typed failure classifications
  (ADR-0029 error enum; ADR-0032 hard-stop). The graph is always complete and
  valid — just less enriched.

## Alternatives considered

- **Put AI inside the adapter (adapter calls the gateway / holds a store).**
  Rejected: violates §7.1 (source-in/IR-out, no store references), forces
  `plugin-api` to grow an AI/store surface (against ADR-0033), and makes the
  adapter non-deterministic and un-conformant. The skeleton/enrichment split
  keeps the parser pure and the trust boundary intact.
- **One fused pass (skeleton and enrichment interleaved).** Rejected: the
  passes could not be cached or refreshed independently, there would be no
  clean degraded floor when AI is absent, and the skeleton would inherit AI
  nondeterminism — breaking conformance and P6/P8.
- **Key element identity on model/provenance to get idempotency.** Rejected:
  re-running with a new model or prompt would fork identity and duplicate
  nodes; ADR-0002/0031 keep identity a pure function of domain coordinates, and
  idempotent merge depends on that.
- **Introduce a shared public `enrich`/hybrid plugin capability this phase.**
  Rejected: Phase 9 proves the pattern *without adding a new plugin capability*
  (ROADMAP §5); composition-root plumbing suffices and avoids freezing an
  enrichment API into 1.0 before it has chafed.
- **Roll back the skeleton (or prior enrichment) when a later pass fails.**
  Rejected by ADR-0032: a stop or failure must *keep* the valid, partially-
  enriched graph and mark it, not discard useful accepted work.

## Tradeoffs & consequences

Buys a domain that is always functional AI-less (P6), an enrichment layer that
is cacheable, idempotent, cancellable, and budget-safe, and a hard trust
boundary where every AI element is tagged, filterable, and reproducible. Costs:
enrichment logic lives in the composition root rather than beside the parser it
serves, so the two halves of an "adapter" are physically split — a deliberate
cost that keeps `plugin-api` narrow and the parser pure. Acceptance must
re-validate proposals against live skeleton state (endpoints/collisions) before
committing, which is real work but is exactly the proposal-gate discipline
ADR-0031 already requires.

## Reasoning

§7.2 already dictates the two-pass shape and §8.1 the proposals-only trust
boundary; the design work is placing the seam so neither the parser contract
(ADR-0033) nor the write path (ADR-0005) widens. Reading the *accepted*
skeleton and emitting proposals from the composition root satisfies both:
the adapter stays "source in, IR out," and AI enters exactly as every other
derived opinion does (§14.1). Anchoring enrichment to skeleton coordinates and
evidence spans — not to model identity — is what makes re-runs idempotent
(ADR-0030 `inputHash`) while keeping IDs stable (ADR-0002). The failure
semantics fall out of ADR-0030 (replay miss = hard failure) and ADR-0032
(budget/provider failure = keep valid partial state).

## Future implications

This is the documented template every future AI-native adapter follows
(research papers, agent workflows, knowledge graphs — §7.3): a deterministic
skeleton parser plus composition-root enrichment through the gateway. Because
enrichment is proposals-only over stable coordinates, P10 inherits the
evidence/inference view separation for free, and P12 agents become a *policy*
looping the same enrichment substrate (§21) — no new trust model. If a shared
enrichment surface ever earns a real second consumer, it can be introduced
additively (ADR-0033's 1.x rule) rather than speculatively now.

## Open questions for review

1. **Where the shared proposal-to-delta materializer lives.** Both adapters
   need the same "validate proposal → atomic delta through the one write path"
   step. Does that domain-neutral materializer belong in an existing internal
   package or remain per-adapter composition-root plumbing? `ai-services` must
   remain **proposal-only**: it may at most host a **pure transformation** if
   its own dependency law permits, and must **never** gain mutation authority
   or a store reference. `plugin-host` is excluded regardless (it may import
   only `plugin-api` and `zod`). Either way the materializer must add **no**
   plugin API surface (ADR-0033) and **no** second write path (ADR-0005) — the
   question is only where to factor it, and whether it is factored at all
   before a second consumer proves the shape.
2. **Argument-extraction objective metric and floor.** ROADMAP §11 requires
   the argument map be "judged faithful against a human-made reference map"
   with an eval floor (§9d), but does not quantify the metric. What is the
   objective measure (e.g. precision/recall of claims and typed relations
   against the reference, or a rubric score) and the numeric floor that gates
   regression? This must be settled with the 9D eval fixture, not invented
   here.
