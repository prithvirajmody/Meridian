# ADR-0011 — Capability model: enumerated kinds, extended per phase

- **Status:** Proposed
- **Date:** 2026-07-05
- **Phase:** 2 (roadmap)
- **Constitution:** ARCHITECTURE.md §14.1, §14.3
- **Roadmap:** ROADMAP.md Phase 2 §8 (ADR-0011)

## Context

Plugins contribute implementations of capability kinds; the host routes each
kind to the subsystem that consumes it. The open question the roadmap assigns
this ADR: is the set of capability kinds an **enumerated, versioned list** or
an **open-ended string namespace** plugins may extend?

## Decision

**Enumerated, extended deliberately per phase.** An unknown capability kind in
a manifest is a manifest error — the plugin does not load — because a host
that "tries anyway" cannot make lifecycle, security, or routing promises for a
capability it doesn't understand (§14.1).

The v1 enum ships in `plugin-api` with five kinds, of which Phase 2
implements one:

| Kind | Declared | Implemented (host routing) |
|---|---|---|
| `domain-parser` | Phase 2 | **Phase 2** — sniff/ingest pipeline |
| `abstraction-provider` | Phase 2 | Phase 3 |
| `layout-provider` | Phase 2 | Phase 4 |
| `view-projection` | Phase 2 | Phase 10 |
| `ai-provider` | Phase 2 | Phase 8 |

Declaring a not-yet-implemented kind is legal (the manifest validates); the
host reports it as registered-but-dormant rather than routing it. The
constitution's full v1 target list (§14.1: `detail-resolver`, `exporter`,
`importer`, `theme`, `interaction-tool`, `analytics`, `validator`) joins the
enum in the phases that build their consuming subsystems — extending the enum
is an additive, minor-version change under ADR-0010.

Naming note: the roadmap's Phase 2 sketch calls the first kind
`domain-adapter`; the constitution's enum (§14.1) names it `domain-parser` and
records the terms as synonyms (§7.1). The constitution wins: the kind string
is `domain-parser`, the plugin-facing interface is `DomainParser`. The package
path convention stays `packages/adapters/<domain>` as both documents show.

## Alternatives considered

- **Open-ended capability strings** with host-side "unknown = ignore".
  Rejected: silently ignoring is how a plugin ships broken; and future
  permission prompts (§14.4 Tier 1) must be able to explain every capability
  to a user, which requires a closed vocabulary.
- **Open-ended with a registry of third-party kind definitions.** Rejected as
  premature platform machinery; nothing before Phase 12 needs it, and ADR-0010
  checkpoints give two scheduled chances to reconsider.
- **Enum containing only `domain-parser`.** Rejected: the four dormant kinds
  are already named by the roadmap's phase plan; declaring them now costs one
  union member each and lets Phase 3/4 plugins be written against a stable
  manifest shape.

## Tradeoffs & consequences

Third parties cannot invent capability kinds — by design; they can ship any
number of implementations of known kinds. Each new kind is a deliberate,
reviewed API change with a named consuming subsystem. The enum's version
history *is* the plugin platform's feature history.

## Reasoning

Capabilities are promises about lifecycle and routing, not tags. A promise the
host can't keep must be refused at validation time, where the error is located
and actionable, not at invocation time deep inside a subsystem.

## Future implications

Phase 3 flips `abstraction-provider` to implemented (the roadmap already
schedules it); Phase 12's permission model attaches grant semantics per
capability kind. If a genuinely third-party capability need appears, the
ADR-0010 checkpoint process is the amendment path.
