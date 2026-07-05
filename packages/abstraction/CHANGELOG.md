# @meridian/abstraction

## Unreleased — Phase 3C

Induced-edge aggregation (ADR-0013). `aggregateEdges(space, cut)` maps every
base edge to its endpoints' visible ancestors, groups verbatim by
`(src, dst, kind)`, sums weights, counts multiplicity, and samples the ≤3
smallest witness `EdgeId`s; internal edges are excluded and above-cut endpoints
omitted; output is deterministic `(src, dst, kind)` order. `capFanOut` is the
separate labeled `M`-cap post-step. `InducedEdgeCache` holds per-visible-node
adjacency with a cover index and invalidates **exactly** the affected members
from a P1 `ChangeSet` (`@meridian/graph-store` joins as a dependency here);
forest-reshaping ops raise `CutStaleError`. Verified by an independent
brute-force equivalence property, an op-count invalidation-exactness suite, and
a 100k-node/8-level resolve benchmark (cold < 150ms, warm < 30ms). Node budget,
overrides, and the `LodResolver` remain deferred to 3D.

## 0.1.0 — 2026-07-05 (Phase 3B)

Initial slice: level chains and cuts. `buildLevelChain` (default
containment-depth chain, or a manifest-declared `LevelChainSpec`), `buildCut`
(the covering antichain at a base level — I5, ADR-0012's default cut), and
`verifyCoverage` (an independent I5 check). Pure functions over immutable
snapshots (P8); imports graph-core only so far (graph-store is permitted by
the dependency law and joins in 3C for ChangeSet-driven cache invalidation).
Induced edges (3C), the node budget / overrides / resolver (3D) are
deliberately not built here.
