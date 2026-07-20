# @meridian/graph-core

**Responsibility.** The Universal Semantic Graph's core: model types
(`GraphSpace`, `SemanticGraph`, `SemanticNode`, `SemanticEdge`), stable-ID
derivation (ADR-0002), pure constructors, the invariant validator (U1–U3,
U7, ADR-0003 attribute rules), the versioned `GraphDocument` codec
(ADR-0004), and `stats`. Domain-blind and presentation-blind: no domain
words, no DOM, no AI, no I/O.

**Public API entry point.** `@meridian/graph-core` (see `src/index.ts`).

**Forbidden imports.** Everything except `zod`. No Node builtins (`node:*`)
— this package stays isomorphic across browser, workers, and Node. Enforced
by dependency-cruiser (`graph-core-only-zod`, `graph-core-no-node-builtins`).

## Conventions fixed here (per ADRs)

- **IDs** (ADR-0002): `n|g|e` + base32(SHA-256(canonical coords)[0..128b]).
  Derivation utilities are pure; the model also accepts opaque hand-written
  IDs (fixtures) — any non-empty NFC string without `U+001F`. U4
  (re-derivation yields the stored ID) binds parsers from Phase 2.
- **Strings are NFC everywhere** (ADR-0004 §normalization): constructors and
  `decode` normalize; `validate` flags non-NFC strings in hand-built spaces.
- **Attribute bags** (ADR-0003): keys match `ns:name`
  (`[a-z][a-z0-9-]*`); values are scalars or homogeneous scalar arrays;
  `core:*` keys are rejected in v1 (`core:salience`/`core:layers` reserved);
  other namespaces produce an `unregistered-namespace` *warning* in Phase 0
  (the Phase 2 IR gate promotes it to rejection). Kind values share the same
  grammar; namespace registration for kinds also lands with plugins.
- **Codec** (ADR-0004): `decode` = strict structural parse (unknown keys
  ignored and dropped) → semantic validation; errors are located, aggregated,
  typed. `encode` is deterministic (sorted graphs/nodes/edges/roots/attr
  keys); `encodeCanonical` (minified, for hashing) and `encodePretty` (for
  fixtures/goldens) derive from the same canonical form. `formatVersion: 1`;
  newer is refused; older will run the chained-migration registry (empty at
  v1, hook signature fixed). ADR-0045 adds an optional typed document `source`
  pin to `DecodeResult`/`EncodeOptions`; it is evidence rather than graph
  semantics, and encode drops it unless a caller deliberately supplies it.
- **Builders are append-only.** Mutation machinery (deltas, transactions) is
  Phase 1; `addGraph`/`addNode`/`addEdge` are pure and return new spaces
  with structural sharing. Builders enforce cheap local invariants;
  space-global checks (cross-graph duplicate IDs, root consistency) are
  `validate`'s job.
