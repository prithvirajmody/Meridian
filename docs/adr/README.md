# Architectural Decision Records

A decision is **finalized only when its ADR is merged here** (CLAUDE.md hard
rule; ROADMAP.md §5.1.5). A decision without a merged ADR is a draft, no matter
how settled it feels.

These records elaborate the constitution's founding decisions
([ARCHITECTURE.md → Architectural Decision Records](../ARCHITECTURE.md#architectural-decision-records-adrs),
entries `ADR-A1…A12`) into implementation-grade commitments. Where a numbered
roadmap ADR maps onto a constitution entry, the mapping is noted in the record.
**The constitution wins every conflict** until amended through its own
amendment procedure.

## Format

One file per decision: `NNNN-kebab-title.md`, ~1 page. Each record carries a
metadata header and then the constitution's five-part frame (Decision,
Alternatives, Tradeoffs, Reasoning, Future implications), preceded by a Context
paragraph and — where a sub-decision is genuinely open — an *Open questions for
review* section.

```markdown
# ADR-NNNN — Title

- **Status:** Proposed | Accepted | Superseded by ADR-XXXX
- **Date:** YYYY-MM-DD
- **Phase:** N (roadmap)
- **Constitution:** ARCHITECTURE.md §§…, ADR-A#
- **Roadmap:** ROADMAP.md Phase N §8

## Context
Why this decision is forced now, and the constraints already fixed above it.

## Decision
What we commit to. Concrete enough to implement and to test against.

## Alternatives considered
Each rejected option with the reason it lost.

## Tradeoffs & consequences
What this costs us and what it buys us.

## Reasoning
Why the decision follows from the constraints and the requirements.

## Future implications
What it enables, and what it locks us into.

## Open questions for review  *(optional)*
Sub-decisions flagged for the human reviewer before acceptance.
```

Lifecycle: a record is **Proposed** when drafted, **Accepted** when the reviewer
approves it (edit the status line in the merging change), and **Superseded** only
by a later ADR that names it — records are never edited away, only sup*erseded*,
so the decision history stays legible.

## Registry

| ADR | Title | Status | Constitution | Phase |
|---|---|---|---|---|
| [0001](0001-recursion-representation.md) | Recursion representation: flat GraphSpace with reference-based recursion | Proposed | ADR-A1, §4 | 0 |
| [0002](0002-identity-deterministic-ids.md) | Identity: deterministic, content-addressed IDs | Proposed | §3.1 (Identity), U4 | 0 |
| [0003](0003-attribute-typing.md) | Attribute typing: typed core keys + namespaced extension bag | Proposed | §3.1 (Metadata), U8 | 0 |
| [0004](0004-document-format-and-versioning.md) | Document format & versioning policy | Proposed | ADR-A4, §6 | 0 |

Later phases extend this registry (ADR-0005+ at Phase 1, and so on). The
constitution's `ADR-A5…A12` are pre-recorded there and become numbered ADRs in
the phase that implements them.
