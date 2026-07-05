# ADR-0006 — Copy-on-write snapshots: graph-granular structural sharing over native Maps

- **Status:** Proposed
- **Date:** 2026-07-05
- **Phase:** 1 (roadmap)
- **Constitution:** ARCHITECTURE.md P3, P13, §4.1, §12.2, §16.2 (memory); ADR-A1
- **Roadmap:** ROADMAP.md Phase 1 §8 (ADR-0006), §6 (technology table: immutability)

## Context

Readers hold immutable snapshots (P3); mutation must produce new versions
cheaply at 10⁵-node scale (P13 budgets: 10k-op delta < 50ms, 1k transactions on
a 100k-node space < 2s, 100-version chain sharing ≥ 90% of node objects).
General-purpose immutability libraries were pre-rejected in the roadmap
(immer too slow, Immutable.js a foreign API); the flat GraphSpace (ADR-0001)
makes a small hand-rolled scheme sufficient. This record fixes that scheme and
its escape hatch.

## Decision

**Copy-on-write over native `Map`, shared at graph granularity.**

- A committed snapshot is an ordinary `GraphSpace`: plain frozen-by-convention
  objects and native `ReadonlyMap`s, exactly as `graph-core` defines them. No
  wrapper types leak into signatures.
- A transaction copies, lazily and at most once each: the space object, the
  `graphs` map, and — only for graphs an op actually touches — that graph's
  object and its `nodes`/`edges` maps. Untouched graphs are shared by
  reference across versions; untouched element objects (nodes/edges) are
  shared even inside touched graphs, because elements are immutable values
  replaced wholesale.
- `snapshot()` returns the current space object — O(1), no copying, safe
  because nothing ever mutates a committed space.
- `roots` is maintained **sorted** in every store snapshot. Rationale: the
  model treats roots as a derived *set* (ADR-0001), but the array's order
  would otherwise depend on op history, breaking the structural-equality leg
  of I4 (`apply(apply(g,d), invert(d)) ≡ g`). Canonical order makes state
  equality structural. `createStore` normalizes the initial space's root
  order the same way.

**Indices live outside snapshots.** The store maintains id-ownership
(element id → owning graph), adjacency (node → in/out edge ids), node-kind,
label-token, and containment (child graph → containing node) indices:

- They are **mutable, head-only** structures updated incrementally per
  committed transaction — never per-version copies. Versioned indices would
  blow the transaction budget (copying a 100k-entry adjacency map 1k times);
  every Phase 1–3 consumer queries the current head.
- In-flight transactions see *overlay* views (base index + pending
  add/remove sets); rollback discards the overlay; commit folds it into the
  base. The base is never touched before commit, so a failed delta leaves
  indices bit-identical.
- Indices are derived state in the §12.2 sense: droppable, rebuildable from
  the snapshot, never authoritative. Equivalence with brute-force
  recomputation is property-tested.

**Escape hatch (binding, per roadmap).** If any Phase 1 perf budget cannot be
met with this scheme on CI hardware, the committed fallback is a HAMT
(persistent-map) library behind the same `GraphStore` interface — an internal
swap, no API change. Adopting it requires a superseding ADR citing the failing
benchmark numbers.

## Alternatives considered

- **immer.** Rejected (roadmap §6): proxy overhead is unacceptable for
  10⁵-node deltas, and its draft semantics fight branded readonly types.
- **Immutable.js / HAMT-first.** Rejected as default: drags a foreign API
  through every signature or adds a dependency before budgets prove need;
  kept as the escape hatch.
- **Per-element copy paths (nested spreads to each node).** Rejected: the flat
  space (ADR-0001) exists precisely so sharing can stop at graph granularity;
  deep paths would reintroduce ancestor copying.
- **Versioned (persistent) indices.** Rejected for v1: cost without a
  consumer; P3 caches key off version stamps, not historical index reads.
  Revisit only if a phase genuinely needs "query at version v".

## Tradeoffs & consequences

- A transaction touching *k* graphs pays O(size of those graphs' maps) copy
  cost once, even for a one-node change in a huge graph — the accepted price
  of native-Map simplicity; budgets police it.
- Head-only indices mean historical snapshots answer queries only through
  recomputation (acceptable: no current consumer).
- Store code must treat committed structures as sacred; discipline is
  enforced by review + property tests (mutating a committed snapshot would
  break the shared-reference tests loudly).

## Reasoning

Structural sharing at the graph boundary is what ADR-0001 bought; native Maps
keep the semantic core dependency-free, isomorphic, and debuggable. The
budgets are the objective test of "simple is enough"; the escape hatch is
pre-agreed so a failure is a swap, not a crisis.

## Future implications

Graph-granular sharing is what makes lazy hydration (§4.7), graph-granular
persistence (P11), and cache keying by `(version, graph)` cheap later. The
≥90 % share property becomes a permanent regression gate. If P12 needs
divergent branches, snapshots already are cheap immutable values.
