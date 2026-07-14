# ADR-0031 — AI trust & provenance: proposals-only writes, provenance additively carries promptVersion + inputHash, always filterable, auto-accept opt-in

- **Status:** Accepted
- **Date:** 2026-07-13
- **Phase:** 8 (roadmap)
- **Constitution:** ARCHITECTURE.md §8.1 (AI trust boundary — deterministic floor, AI writes nothing directly, always filterable), §3.1 (Provenance, `SourceRef`; Layer model), §14.1 (derived opinion enters as tagged proposals); ADR-A5 (this is one of its reserved ADRs, `ADR-0029/0031`), ADR-0005 (one write path), ADR-0002 (identity)
- **Roadmap:** ROADMAP.md Phase 8 §2, §7 (AI provenance `SourceRef`), §8 (ADR-0031), §11, §12 (UI verification)
- **Related:** ADR-0029 (which provider/model produced the output), ADR-0030 (the replay key whose fields provenance mirrors)

## Context

The constitution's AI trust boundary (§8.1) is three rules: a deterministic floor
exists for every AI feature; **AI writes nothing directly** — services emit
proposals that become tagged deltas; and AI-derived structure is **always visually
distinguishable and globally filterable**. P0 already models the provenance record
(`SourceRef { origin:'ai', model, promptVersion, inputHash, confidence }`, ROADMAP
§7); Phase 8 populates it for real. This record fixes how AI output enters the graph
and what identity it carries, aligned with the now-multi-provider seam (ADR-0029)
and the replay key (ADR-0030) so a proposal's provenance reproduces the exact call
that generated it — **additively**, without changing node identity or the single
write path.

## Decision

**AI writes only via proposals → tagged deltas; never a second write path.** Every
AI service (SummarizingAbstractionProvider, EmbeddingClusterer, StructureExtractor,
…) emits *proposals* (`AbstractionProposal` / `GraphProposal`). Acceptance turns a
proposal into ordinary op-based deltas through the **one write path** (ADR-0005);
the AI layer holds no privileged store access. This is derived opinion entering as
tagged proposals exactly like analytics or alias detection (§14.1).

**Provenance is additive over stable identity.** Accepted AI structure carries
`SourceRef { origin:'ai', providerId, model, promptVersion, inputHash, confidence }`
as **metadata on nodes/edges whose IDs are computed the ordinary deterministic way**
(ADR-0002). Provenance never participates in identity and never mutates it —
adding, filtering, or stripping AI provenance changes no node ID. The record
**additively carries `promptVersion` and `inputHash`** (the newly-populated fields
this phase adds) alongside `model` and `providerId`, so that:
- the origin fields are exactly the ADR-0030 replay key `(providerId, model,
  promptVersion, inputHash)` — a node names the reproducible call that made it; and
- adding these fields is backward-compatible: pre-P8 records without them remain
  valid (fields are optional-additive, per §3.1 metadata evolution).

`confidence` is promoted to typed `SourceRef` provenance so UI and evals can rank
proposals. Rationale remains review-time proposal data. Evidence is optional
domain data in the namespaced attribute bag (`ai:evidence`) rather than another
identity/provenance field.

**Always filterable and visually distinct.** AI-derived structure is globally
filterable and visually distinguishable at all times (§8.1.3): one toggle shows the
graph as evidence-only (non-AI), and AI-origin nodes/edges render distinctly.
Filtering is by the `origin:'ai'` tag; it is a view operation and removes nothing
from the store. (Studio wiring lands in subphase 8F; this record fixes the
guarantee the UI must honor.)

**Acceptance is human-in-the-loop by default; auto-accept is opt-in.** Proposals
are reviewed and accepted by a human by default. **Auto-accept is an explicit,
per-project, per-service opt-in setting** (§8.1.2) — never a default, never global.
Even auto-accepted proposals become the same tagged, filterable deltas; auto-accept
changes *who* clicks accept, never the write path, the tagging, or the filterability.

**Rejection and repair are honest.** A schema-invalid response gets one repair
attempt then is rejected with the raw response retained (§8.3.4); a rejected or
budget-stopped proposal leaves the graph in a valid state (ADR-0032). Nothing
half-written ever bypasses the proposal gate.

## Alternatives considered

- **Trusted services write directly.** Rejected by §8.1.2 and ADR-0005: a second
  write path destroys the op-log/undo/provenance guarantees and the "evidence vs
  inference" separation reasoning tools require (ADR-A5).
- **Provenance participates in identity** (e.g. hash the model into the node ID).
  Rejected: re-running with a new model or prompt would fork identity and duplicate
  nodes; ADR-0002 keeps identity a pure function of domain coordinates, and P9's
  idempotent enrichment (keyed by inputHash) depends on that.
- **Global auto-accept default.** Rejected: erases the human-in-the-loop trust
  boundary; auto-accept must be a deliberate per-source choice.
- **Store only `model`, not `promptVersion`/`inputHash`.** Rejected: without them a
  node cannot be tied back to its reproducible call (ADR-0030), breaking audit,
  eval attribution, and P9 idempotency.
- **Filter by deleting AI structure from a view copy.** Rejected: filtering is a
  view predicate over the `origin` tag; nothing is removed, so the toggle is
  lossless and reversible.

## Tradeoffs & consequences

Buys a hard trust boundary (every AI fact is tagged, filterable, and traceable to a
reproducible call), backward-compatible provenance growth, and identity stability
across model/prompt changes. Costs: services must always route through the proposal
API (no shortcut for "obvious" outputs), and every accepted element carries a few
extra provenance fields (negligible; already modeled in P0). The additive fields
widen `SourceRef` — additive-only, so no schema break.

## Reasoning

§8.1 is non-negotiable; the only new work is populating provenance for real and
making its fields line up with the ADR-0029/0030 identity of the call. Keeping
provenance additive and out of identity is what lets AI be re-run, swapped across
providers, and filtered without churning the graph — the same discipline ADR-0028
uses for aliases (continuity as additive metadata over stable IDs). Auto-accept as
opt-in preserves user trust while still enabling automation for those who choose it.

## Future implications

P9's hybrid adapters re-run AI enrichment idempotently keyed by `inputHash` (a
field this record guarantees is present); a re-run updates rather than duplicates.
The filter toggle and provenance fields are the substrate for P10's evidence/
inference view separation and P12 agents, which inherit this trust model unchanged
(ADR-A5 "F"). New provenance origins (a future analytics or rename-detector source)
slot into the same additive `SourceRef` shape.

## Resolved implementation decisions (2026-07-13)

1. **Rationale/evidence shape:** `confidence` is a typed `SourceRef` field;
   evidence stays in `attrs['ai:evidence']`; rationale is retained on the pending
   proposal for review and is not copied into provenance automatically.
2. **Auto-accept threshold:** each per-service rule is disabled unless explicitly
   enabled and may specify `minConfidence`. Every group must carry confidence at
   or above the floor; a missing confidence does not clear a configured floor.
