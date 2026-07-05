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

**Deferred to 3C/3D (not built here):** induced-edge aggregation
(`aggregateEdges`, ADR-0013), per-node overrides / node budget / hysteresis
(ADR-0012/0014), and the `LodResolver`. The `CutReason` vocabulary and the
`LevelChain` shape are the seams those build on.

**Public API entry point:** `@meridian/abstraction` (`src/index.ts`). Key
exports: `buildLevelChain`, `buildCut`, `verifyCoverage`, `LevelChain`,
`LevelChainSpec`, `Cut`, `CutMember`, `CoverageProof`.

**Forbidden imports:** everything except `@meridian/graph-core` and
`@meridian/graph-store` (§20 dependency law; enforced by dependency-cruiser).
No domain vocabulary (the core is domain-blind, P1 — grep-audited in CI), no
DOM, no AI, no presentation, no `node:*` builtins (isomorphic).

Invariants owned here: **I5** (cut coverage), property-tested on random
forests, plus determinism (I6) of `buildCut`/`buildLevelChain`.
