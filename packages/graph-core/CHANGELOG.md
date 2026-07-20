# @meridian/graph-core

## Unreleased — bridge-v1 integration

- Added ADR-0045's optional typed `DocumentSource` to GraphDocument decode and
  canonical encode. Legacy documents are unchanged; transformed spaces do not
  inherit a source pin unless the caller explicitly supplies trusted metadata.

## 0.1.0 — 2026-07-05 (Phases 0–2)

- **Phase 0:** USG model, branded IDs (ADR-0002 derivation), constructors,
  whole-space validation (U1–U3, U7, ADR-0003 attribute discipline), the
  versioned `GraphDocument` codec with canonical encoding (ADR-0004), stats,
  containment traversal.
- **Phase 2:** the promised U8 gate went live — `validate`/`decode` accept an
  optional `vocabulary` (`VocabularyRegistry`); with it, unregistered
  namespaces/keys/kinds and declared-type mismatches are errors (new issue
  codes `unregistered-attr-key`, `attr-type-mismatch`, `unregistered-kind`).
  Added `AttrValueType` + `attrValueMatchesType`. Without a vocabulary,
  Phase 0/1 behavior is unchanged.
