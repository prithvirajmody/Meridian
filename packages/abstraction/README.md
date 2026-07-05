# @meridian/abstraction

The abstraction engine of the semantic core (ROADMAP Phase 3): it makes
"level of abstraction" a **computable value**, not a UI mood. Pure functions
over immutable `GraphSpace` snapshots (constitution P8) — the whole engine is
testable headless and can run in a worker.

**Phase 3B slice (this build):**

- `buildLevelChain(space, spec?)` — a domain's ordered, named abstraction
  levels. A parser contributes names through its manifest (`LevelChainSpec`,
  mirrored in `@meridian/plugin-api`); a domain that declares nothing gets a
  **default containment-depth chain** synthesized from the forest, so the
  markdown corpus zooms with zero adapter changes.
- `buildCut(space, chain, level)` — the visible antichain at a base level: for
  every root→leaf path, the node at that containment depth, or the leaf when
  the path bottoms out first (ragged hierarchies). Satisfies **I5 — cut
  coverage**: every leaf is covered exactly once. Each `Cut` carries a
  covering proof; `verifyCoverage` re-derives I5 by an independent method.

**Phase 3C slice (this build):**

- `aggregateEdges(space, cut)` — induced-edge aggregation (ADR-0013). Each base
  edge maps to a weighted, typed edge between its endpoints' **visible
  ancestors** `A(u) → A(v)`; grouped verbatim by `(src, dst, kind)`; `weight =
  Σ (w ?? 1)`; `multiplicity` = member count; `samples` = the ≤3 smallest
  witness `EdgeId`s. Internal edges (`A(u) === A(v)`) are excluded; an endpoint
  strictly above the cut has no single visible ancestor and its edge is
  omitted. Deterministic `(src, dst, kind)` order (I6). Non-destructive.
- `capFanOut(edges, budget?)` — the **separate, labeled** hub-explosion valve
  (ADR-0013's `M = 32`): keep the top-`budget` induced edges per node and
  direction, fold the rest into one residual marker. Never part of aggregation
  (the brute-force equivalence property holds over the uncapped set).
- `InducedEdgeCache(space, cut)` — per-visible-node adjacency with a cover
  index, invalidated **exactly** via P1 `ChangeSet`s: an edge/attr change
  recomputes only the affected members (`applyChange`), never the whole cut;
  forest-reshaping ops raise `CutStaleError` (rebuild the cut). This is where
  the `@meridian/graph-store` dependency enters.

**Deferred to 3D (not built here):** per-node overrides / node budget /
hysteresis (ADR-0012/0014) and the `LodResolver` that wires `capFanOut` into a
`LodResult`.

**Public API entry point:** `@meridian/abstraction` (`src/index.ts`). Key
exports: `buildLevelChain`, `buildCut`, `verifyCoverage`, `aggregateEdges`,
`capFanOut`, `InducedEdgeCache`, `buildNodeCover`, `LevelChain`,
`LevelChainSpec`, `Cut`, `InducedEdge`, `CappedFanOut`, `CutStaleError`.

**Forbidden imports:** everything except `@meridian/graph-core` and
`@meridian/graph-store` (§20 dependency law; enforced by dependency-cruiser).
No domain vocabulary (the core is domain-blind, P1 — grep-audited in CI), no
DOM, no AI, no presentation, no `node:*` builtins (isomorphic).

Invariants owned here: **I5** (cut coverage), property-tested on random
forests, plus determinism (I6) of `buildCut`/`buildLevelChain`/`aggregateEdges`.
Induced-edge aggregation is checked against an independent brute-force
implementation (equivalence property) and its cache against exact op-count
invalidation; the 100k-node/8-level resolve budget lives in
`benchmarks/abstraction-cut.bench.mjs`.
