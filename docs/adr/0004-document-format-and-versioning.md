# ADR-0004 — Document format & versioning policy

- **Status:** Proposed
- **Date:** 2026-07-05
- **Phase:** 0 (roadmap)
- **Constitution:** ARCHITECTURE.md §6 (IR), §3.3, ADR-A4; P4, P12
- **Roadmap:** ROADMAP.md Phase 0 §8 (ADR-0004), §5.3 (I3)

## Context

`GraphSpace` needs a portable serialized form so that fixtures, exports, caches,
and (later) sync payloads all share one format, and so that every invariant is
enforced at one gate rather than trusted across N producers (§6.1, P4). The format
is an external surface, so it must be versioned from v1 (§3.3), and it must evolve
without breaking old projects (P12). Phase 0 defines the **document** (full
snapshot) form; the **delta** document form is Phase 1 (ADR-0005) but inherits
this version policy.

## Decision

- **One model, two forms.** `GraphDocument` is the wire form of the same USG the
  store holds in memory — not a separate "parser IR" (ADR-A4). `encode(space) →
  GraphDocument` and `decode(doc) → GraphSpace` are inverses over valid input
  (I3).
- **Wire encoding:** UTF-8 **JSON** for v1 — diffable, debuggable, universal.
  Designed columnar-friendly (flat element arrays, no deep nesting, a benefit of
  the flat space, ADR-0001) so a binary/compressed codec can later replace it as a
  pure swap with no model change.
- **Required fields** (§6.2): `formatVersion`; producer identity + version (which
  adapter/tool, for forensics); the graph set, each graph carrying id, meta,
  nodes, edges; the containment/detail references; and **provenance on every
  element** (U7). Deltas add `baseVersion`, `ops`, `origin` — defined in Phase 1.
- **`formatVersion` is a required integer**, `1` at launch, **bumped only for
  breaking shape changes** (removing or retyping a known field). **Additive
  optional fields do not bump it.** There is no unversioned document (§3.3).
- **Forward/backward rules** at `decode`:
  - version **>** supported → **refuse** with a typed error (no silent
    best-effort on a format we do not understand);
  - version **==** supported → strictly validate *known* fields, and **ignore
    unknown keys** (this is what makes same-version additive fields
    forward-compatible; unknown keys are dropped, not preserved, in v1);
  - version **<** supported → run the migration chain up to current, then
    validate.
- **Migration** (§6.5): single-step **pure** functions, chained.
  `type Migration = { from: number; to: number; up(doc: JsonValue): JsonValue }`,
  held in an ordered registry; `decode` applies `from = doc.formatVersion` upward
  to current before structural validation. **Any→current direct migrations are
  forbidden** (they need O(N²) paths and rot). Down-migration is unsupported in
  v1. Every historical fixture is retained at its original version and must
  migrate cleanly to current in CI.
- **Normalization** (§6.3), so equality and hashing are meaningful: canonical
  object-key ordering, elements sorted by ID, Unicode **NFC** on all strings,
  canonical number formatting. The **canonical** rendering (sorted, minified) is
  what gets hashed (content-addressed caching, ADR-0002); a **deterministic
  pretty** rendering (sorted keys, sorted elements, 2-space) is what fixtures and
  goldens store. Both derive from one canonical model, so goldens are byte-stable.
- **Validation is two passes, both at the gate** (§6.4, P4): **structural** (zod
  parse — is every field the right shape) then **semantic** (U1 references
  resolve, U2 acyclic containment, U3 single ownership, U4 id determinism where
  checkable, U7 provenance present, U8 namespace discipline per ADR-0003). Errors
  are **located** (element id + field), **aggregated** (all errors, not the
  first), and **typed** (parser-bug vs unregistered-namespace vs integrity), so
  tooling can react. Nothing failing either pass enters the store.

## Alternatives considered

- **A separate parser-AST IR** distinct from the core model. Rejected (ADR-A4):
  two models drift; parsers must map to the core eventually anyway.
- **Per-parser direct store writes, no document gate.** Rejected: N integrity
  regimes instead of one; no portability, no golden testing.
- **A semver string, or no version field.** Rejected: an integer `formatVersion`
  is sufficient for a wire schema, and an unversioned external surface is
  forbidden (§3.3).
- **Strictly rejecting unknown keys at a supported version.** Rejected: it
  contradicts "additive fields do not bump the version" — an older decoder must
  tolerate a newer same-version additive field, so unknown keys are ignored, not
  rejected.
- **Any→current migrations.** Rejected: O(N²) migration paths that die of neglect.

## Tradeoffs & consequences

- **Cost:** canonicalization and a forever-growing chained migration set to
  maintain; producers must think in USG terms rather than emitting a private
  format.
- **Benefit:** one enforcement gate; portability across fixtures, exports, caches,
  and sync; byte-stable goldens and content-hash caching; free internal evolution
  behind a stable versioned exterior.

## Reasoning

Hourglass economics (§1.1): N parsers writing directly is N integrity regimes,
whereas one gated, versioned document is one. Chained single-step migrations are
each written once and are the only migration strategy that survives years of
format drift.

## Future implications

A binary/columnar codec becomes a pure encoder swap. Delta documents (Phase 1),
sync payloads (§21), export files, and cache artifacts are all `GraphDocument`s
under this same version policy. Format evolution is chained migrations, forever.

## Open questions for review

1. **Unknown-key handling.** Recommendation: at a supported version, *ignore*
   unknown keys (forward-tolerance) and drop them on re-encode. If lossless
   forward round-tripping ever matters, we switch to *preserve* unknown keys —
   an additive change. Confirm ignore-and-drop for v1.
2. **Canonical vs pretty renderings.** Two deterministic renderings (minified for
   hashing, pretty for goldens) from one canonical model. Confirm, or standardize
   on a single rendering for both.
