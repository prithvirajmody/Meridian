# ADR-0002 — Identity: deterministic, content-addressed IDs

- **Status:** Proposed
- **Date:** 2026-07-05
- **Phase:** 0 (roadmap)
- **Constitution:** ARCHITECTURE.md §3.1 (Identity), §3.2 (U4), §6.3; ADR-0028 reserved
- **Roadmap:** ROADMAP.md Phase 0 §8 (ADR-0002), §5.3 (I6)

## Context

Incremental re-ingestion, durable annotations, durable Views, and cross-run
diffing all require that the same semantic entity keeps the same ID across
ingests, machines, and time (§3.1 Identity, U4). Random IDs make every one of
those features impossible. The ID scheme is, with recursion, one of the two
Phase 0 decisions that cannot be reversed cheaply later, so it is fixed now.

## Decision

IDs are **deterministic functions of an element's semantic coordinates**, never
random and never sequential.

- **Branded string types** `NodeId`, `GraphId`, `EdgeId` are compile-time
  distinct (a `NodeId` is never assignable to a `GraphId`), preventing ID mix-ups
  in signatures.
- **Coordinate tuple:** an ID is derived from `(domain, source, semanticPath)`:
  - `domain` — the producer's namespace (`markdown`, `code`, …); `core` for
    platform-created elements (e.g. clusters, ADR-A7).
  - `source` — a stable identifier for the origin (canonical URI/path, or a
    content-derived source key when no stable URI exists).
  - `semanticPath` — an ordered list of stable local segments from the source
    root to the element (e.g. a section-slug chain, a symbol path). The producer
    defines the scheme; its stability under *unrelated* edits is what makes
    re-ingest deltas small, and is part of the parser conformance kit (P2, §7.4).
- **Derivation:** `id = tag ++ base32( SHA-256( canonical(tuple) )[0..128 bits] )`,
  where `tag ∈ {n, g, e}` disambiguates element kinds (so a node and a graph with
  identical coordinates cannot collide), `canonical(...)` applies the same
  canonicalization as the codec (NFC strings, fixed separators, ADR-0004 §6.3),
  and the 128-bit truncation keeps IDs short enough for readable fixtures/goldens
  while leaving collision probability negligible at project scale. `deriveId` is a
  **pure function** in `graph-core`; determinism is I6, property-tested from
  Phase 0.
- **GraphId of a detail graph** is derived from its containing node's coordinates
  (the "detail-of" relation), so containment is stable and reconstructible.
- **EdgeId** is derived from `(graphId, kind, srcNodeId, dstNodeId, occurrenceKey)`.
  `occurrenceKey` is empty for the common single-edge case and is supplied by the
  producer only when several same-kind edges connect the same ordered pair (e.g.
  two distinct call sites), so re-ingesting the same relation yields the same
  EdgeId.
- **Renames are remove + add in v1.** A change to `semanticPath` produces a new
  identity; the old element is removed and a new one added. An **alias table** for
  identity continuity across renames is *reserved* and deferred to roadmap
  **ADR-0028** — not built in Phase 0. *(Amended during 7A: ADR-0028 as drafted
  is broader than the alias table — it fixes ID stability under edits generally
  (the code-domain coordinate mapping, hard-case rules) and reserves the alias
  mechanism concretely as a `core:alias-of` edge populated by a future detector
  via tagged proposals.)*
- **Provenance-span freshness** *(added during 7A, per ADR-0028)*: incremental
  re-ingest delta equality **excludes provenance spans** — an element whose
  identity and content are otherwise unchanged emits no op even when its span
  shifted. Spans are guaranteed current after any *substantive* edit or a full
  ingest, **not** after a pure-whitespace edit; span exactness yields to delta
  minimality (the empty-delta invariant, ROADMAP Phase 7 §11).
- **Uniqueness and integrity** are enforced by the store/gate: duplicate IDs are
  rejected; every reference must resolve (U1). U4 is enforced as (a) purity of
  `deriveId` and (b) identity-stability under no-op re-ingest (P2 conformance),
  not by storing the coordinate tuple on every element.

## Alternatives considered

- **Random UUIDv4.** Rejected: re-ingesting an unchanged source yields fresh IDs,
  so incremental diffing, annotation survival, View durability, and cross-run
  comparison all break.
- **Sequential / auto-increment IDs.** Rejected: order-dependent, unstable across
  runs, and collision-prone under any future merge.
- **Content hash of the element's *content*** (body text, attribute values).
  Rejected: editing a function body would change its identity, defeating "the
  same entity across versions." Identity must track an element's *position/role*,
  not its content.

## Tradeoffs & consequences

- **Cost:** every producer must define a stable `semanticPath` scheme — a real
  per-adapter design burden, and a conformance requirement. Renames lose identity
  continuity until the alias table lands.
- **Benefit:** incremental updates are diffable, annotations and Views are
  durable, cross-run diff is possible, and goldens are deterministic.

## Reasoning

Stable identity is a precondition for the platform's incremental and
collaborative story, and the only way to get it without a central ID authority is
to derive IDs from stable semantic coordinates. Hashing keeps IDs fixed-width,
opaque to ordering, and cheap to compute in any runtime.

## Future implications

The alias table (ADR-0028) later adds rename continuity without changing this
scheme. Version stamps carry a reserved site-ID component (ADR-0007) orthogonal to
element IDs. A future binary/columnar codec can store the fixed-width IDs
compactly.

## Open questions for review

1. **ID length / encoding.** 128-bit truncation, base32, `n|g|e` prefix — enough
   headroom and readable in goldens. Confirm, or prefer full-width or a different
   encoding.
2. **Parallel-edge `occurrenceKey`.** Adopting an explicit producer-supplied
   discriminator (vs. forbidding parallel same-kind edges, or auto-indexing them).
   Recommended as specified; flagging because it shapes the edge model.
3. **Coordinate storage.** Recommendation: do *not* store the full coordinate
   tuple on every element (U4 enforced via `deriveId` purity + re-ingest
   conformance). If you want a decoder to re-verify U4 on a third-party document
   without re-running its adapter, we would add an optional coordinates field
   additively — say the word and it goes in the v1 shape.
