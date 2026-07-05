# ADR-0003 — Attribute typing: typed core keys + namespaced extension bag

- **Status:** Proposed
- **Date:** 2026-07-05
- **Phase:** 0 (roadmap)
- **Constitution:** ARCHITECTURE.md §3.1 (Metadata), §3.2 (U8), §6.5
- **Roadmap:** ROADMAP.md Phase 0 §8 (ADR-0003)

## Context

Every element needs an attribute bag rich enough for unlimited domain
expressiveness (`code:cyclomatic`, `conv:tokens`) yet disciplined enough to avoid
schema anarchy (U8: every attribute namespace is core or declared by a registered
schema). Phase 0 has no plugins, so no plugin-supplied schemas exist yet; this
record fixes the *model shape and the namespace rule* now, and defers schema
*validation* to Phase 2 where plugins arrive. The governing risk (Phase 0 §9a) is
over-modeling attributes for domains that do not exist — so the concrete core set
starts minimal and grows additively.

## Decision

- **First-class fields are not attributes.** `id`, `kind`, `label`, `detail`,
  `provenance` (node), and `src`/`dst`/`kind`/`weight` (edge) are structural
  fields, not bag entries. Everything else lives in an `AttrBag`.
- **`AttrBag = Record<string, AttrValue>`** on every node, edge, and graph, where
  each **key is either a core key or a namespaced `ns:key`**:
  - **Core keys** are a small, closed, platform-typed set (the `core:` namespace,
    plus the platform's reserved plain keys). Only the platform may emit them;
    producers supplying a core key with the wrong type are rejected.
  - **Namespaced keys** (`code:cyclomatic`, `conv:tokens`) carry a domain
    namespace. Their **validation against a plugin-registered zod schema is Phase
    2**; in Phase 0 the *only* legal namespace is `core:`, and any other namespace
    is reported by the validator as an `unregistered-namespace` finding (typed, so
    Phase 2's gate can promote it from "tolerated in P0" to "rejected").
- **`AttrValue`** is a JSON-serializable **scalar or array of scalars**:
  `string | number | boolean | null | Array<string | number | boolean>`. Nested
  objects are disallowed in v1 — this keeps serialization flat and
  columnar-friendly (§6.5); a domain needing structured values does so through a
  registered schema when schemas land (P2).
- **v1 core key registry.** The bag ships **effectively empty** — the model and
  the rule are what Phase 0 fixes, not a speculative attribute catalog. Two names
  are **reserved but not yet emitted**, so no domain can squat them: `core:salience`
  (`number`, later feeds LOD/budget, §5.1) and `core:layers` (`string[]`, later
  layer membership, §3.1). "Reserved" means the platform rejects these keys from
  domain producers; it is namespace hygiene, not dead code. New core keys are
  added additively (they do not bump `formatVersion`, ADR-0004).

## Alternatives considered

- **Fully free-form untyped map** (any key, any JSON). Rejected: no validation, no
  way to enforce U8, and inevitable silent collisions between domains that both
  pick `weight` or `color`.
- **Fully closed typed schema** (fixed columns, no extension). Rejected: every new
  domain attribute becomes a core change — exactly the waist erosion (§20, risk
  #8) the architecture exists to prevent.
- **Per-domain side tables** instead of an in-element bag. Rejected: turns every
  read into a join and breaks single-element portability in the IR (an element
  should serialize with its own attributes).

## Tradeoffs & consequences

- **Cost:** a two-tier key convention to honor; namespace-registration ceremony
  from Phase 2 on; `AttrValue` restricted to scalars/arrays in v1.
- **Benefit:** unlimited domain expressiveness with exactly one extension
  mechanism to validate, document, and migrate; flat, columnar-friendly
  serialization; the core stays free of domain vocabulary.

## Reasoning

One extension mechanism (§6.5) that can be validated, documented, and migrated is
worth more than either extreme. Fixing the *shape and rule* now — while deferring
the *schema plumbing* to the phase that introduces plugins — keeps Phase 0 from
over-modeling while still making the model coherent and testable.

## Future implications

Phase 2 realizes namespaced validation: plugin manifests register zod schemas
(`attrSchemas`), and the IR gate rejects unregistered or ill-typed namespaced
attributes (P4, U8). Analytics, AI-enrichment, and layer data all attach as
namespaced attributes without any core change. Richer value types, if ever
needed, arrive through a registered schema, not a loosening of the base bag.

## Open questions for review

1. **Initial core key set.** Recommendation: ship empty except the two reserved
   names (`core:salience`, `core:layers`), adding real core keys only when a
   fixture or phase needs them. Confirm, or name any core keys you want present in
   v1 now.
2. **`AttrValue` breadth.** Scalars + scalar arrays only in v1. Confirm, or allow a
   restricted structured value type up front.
