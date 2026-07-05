# @meridian/abstraction

## 0.1.0 — 2026-07-05 (Phase 3B)

Initial slice: level chains and cuts. `buildLevelChain` (default
containment-depth chain, or a manifest-declared `LevelChainSpec`), `buildCut`
(the covering antichain at a base level — I5, ADR-0012's default cut), and
`verifyCoverage` (an independent I5 check). Pure functions over immutable
snapshots (P8); imports graph-core only so far (graph-store is permitted by
the dependency law and joins in 3C for ChangeSet-driven cache invalidation).
Induced edges (3C), the node budget / overrides / resolver (3D) are
deliberately not built here.
