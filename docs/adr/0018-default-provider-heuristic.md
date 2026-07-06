# ADR-0018 — Default provider heuristic: a pure classifier over (cut, inducedEdges)

- **Status:** Proposed
- **Date:** 2026-07-06
- **Phase:** 4 (roadmap)
- **Constitution:** ARCHITECTURE.md §5.1 (cut/induced edges), §5.2 (level sources), §3.2 (I6); ADR-A3
- **Roadmap:** ROADMAP.md Phase 4 §3, §8 (ADR-0018), §9, §12

## Context

Four providers ship (`elk-layered`, `d3-force`, `tree`, `grid`; §3). When the
caller does not name one, the engine must pick per view shape: "layered for DAG-ish
cuts, force for cluster-ish; the heuristic that picks" (§8; subphase 4E). The
roadmap requires this be a **deterministic, testable metric computed from
`(cut, inducedEdges)`** and a **pure function of the input**. This record fixes the
metric, the decision thresholds, and the tie-breaks that make it deterministic
(I6). It picks a *default* only; an explicit provider selection (user/view) bypasses
it entirely.

## Decision

**Signature.** `chooseProvider(cut: Cut, edges: readonly InducedEdge[]) →
'grid' | 'tree' | 'elk-layered' | 'd3-force'` — pure, no randomness, no I/O, no
clock. Runs on the main thread before dispatch (ADR-0017), so it must be cheap
(O(V + E), with one guarded exception noted below).

**Derived signals** (all from `cut.members` and `edges`; `V = |cut.members|`):
- Collapse the directed induced multigraph to a **simple undirected** graph over
  members (an induced edge and its reverse, and parallel kinds, count once).
  `E` = number of distinct undirected member-pairs with ≥ 1 induced edge.
- `comp` = connected-component count (undirected; isolated members count as
  singletons), via union-find in ascending-`NodeId` order.
- `avgDeg = 2E / V` (0 when `V = 0`).
- `density = E / (V·(V−1)/2)` for `V ≥ 2`.
- `backRatio` = directed DFS back-edge fraction: run DFS from members in ascending
  `NodeId` order, count edges to a node on the active stack, divide by directed
  edge count (`0` when there are no directed edges). `backRatio = 0 ⟺ acyclic`.
  (Exact minimum feedback-arc-set is NP-hard; the ascending-`NodeId` DFS back-edge
  count is a *deterministic* proxy — same input, same number.)
- `C` = average local clustering coefficient (fraction of a node's neighbor-pairs
  that are themselves adjacent, averaged over nodes with degree ≥ 2), a
  cluster/tangle signal in `[0, 1]`.

**Thresholds** (frozen as *mechanism* here; re-tuned in 4E against real corpus
SVGs, per the ADR-0012 pattern):
- `β = 0.05` — max `backRatio` to count as "acyclic enough" for layering.
- `δ = 6` — the `avgDeg` boundary between "sparse/layerable" and "dense/tangled."
- `γ = 0.35` — the `C` boundary above which a graph is "cluster-ish."

**Decision (first match wins — deterministic):**

1. `V ≤ 1` → **`grid`** (empty or single node; nothing to relate).
2. `E == 0` → **`grid`** (pure node-soup / fully disconnected; a graph layout has
   no relations to honor — grid packs them, ADR-0015 component packing).
3. Induced graph is a **forest** (`E == V − comp` and undirected-acyclic) →
   **`tree`** (containment-shaped, hierarchical, no cross edges).
4. **DAG-ish:** `backRatio ≤ β` **and** `avgDeg ≤ δ` → **`elk-layered`** (layered
   engines excel on sparse, near-acyclic flow).
5. **Cluster-ish:** `C ≥ γ` **or** `avgDeg > δ` → **`d3-force`** (organic layout for
   tangled/clustered/dense graphs).
6. Otherwise → **`d3-force`** (the messy middle — a sparse-but-cyclic graph that is
   neither cleanly layerable nor obviously clustered; force degrades most
   gracefully).

**Determinism (I6).** Every traversal (DFS start order, union-find, clustering
iteration) and every tie-break resolves by **ascending `NodeId`**; the function is a
pure deterministic map from `(cut, inducedEdges)` to a provider id. This is a test
(roadmap: "must be a pure function of the input"; 4E: force determinism is a test —
its *selection* is deterministic here, its *output* seeded in ADR-0016/§9b).

**Cost guard.** `C` is the only signal that can exceed O(V + E): it is
`O(Σ deg²)`, which a hub blows up. When `V` exceeds a bound `V_max` (proposed
`5000`, the node-budget scale from ADR-0014), the classifier **skips `C`** and
decides on `backRatio` + `avgDeg` alone (rules 4/5/6 with the `C ≥ γ` disjunct
dropped). This keeps the main-thread classifier inside ADR-0017's 4ms budget.

## Alternatives considered

- **Always `elk-layered` (or always `force`).** Rejected: elk is slow and ugly on
  dense/cyclic graphs; force is slow and shapeless on clean DAGs. The whole point of
  four providers is shape-fit.
- **Learned / statistical classifier.** Rejected: non-deterministic to train and
  opaque to test; the roadmap demands a pure, testable metric.
- **Exact minimum feedback-arc-set for cyclicity.** Rejected: NP-hard; the
  ascending-`NodeId` DFS back-edge proxy is deterministic and adequate for a
  DAG-ish/not gate.
- **Modularity / community detection as the cluster signal.** Rejected for v1: more
  expensive and itself heuristic; average clustering coefficient is cheap,
  deterministic, and a good-enough "is this tangled" proxy. (Real clustering *levels*
  are ADR-0014/P8's job, not the layout picker's.)
- **Letting the picker choose per-component** (elk here, force there). Rejected: one
  cut renders under one provider so the SVG/goldens are coherent; disconnected
  components are placed by ADR-0015 packing, not by mixing engines.

## Tradeoffs & consequences

- Buys: a cheap, pure, testable default that fits the common shapes (code import
  DAGs → layered; conversation/argument tangles → force; pure containment → tree;
  soup → grid) with three named, tunable thresholds.
- Costs: three magic constants (`β, δ, γ`) that need 4E tuning; a proxy (not exact)
  cyclicity measure; a `V_max` guard that makes very large cuts decide on fewer
  signals.
- Because ADR-0016's stability gate lives on elk/force (not grid/tree), the picker
  should be understood as choosing the *stable* engines for genuine graphs and the
  fallbacks only for the degenerate shapes (rules 1–3) — which it does.

## Reasoning

The four providers exist precisely because no single layout suits every shape; a
default picker is only defensible if it is deterministic and testable, so it must be
a pure function of the two things a cut *is* — its members and their induced edges.
Acyclicity + sparsity is the textbook signature of "layer this"; high clustering or
density is the signature of "let it relax organically"; a literal forest wants a
tree; a soup wants a grid. The thresholds are mechanism now and feel later (4E),
exactly as ADR-0012 froze its hysteresis constants.

## Future implications

The classifier is reused wherever a default layout is needed without a human in the
loop (batch SVG export, P7 dogfood, P11 benchmarks). Its signals (`backRatio`,
`avgDeg`, `C`, `comp`) are a compact "shape fingerprint" of a cut that P6 can log
for navigation analytics and P10 projections can consult when deciding
`suitability()` for alternative media. New providers (deferred: constraint-based,
bundled) slot in as new rules without disturbing the existing ones.

## Open questions for review

1. **Threshold values `β = 0.05`, `δ = 6`, `γ = 0.35`.** Proposed as mechanism,
   re-tuned in 4E against real corpus SVGs. Confirm the starting points, or set
   domain-specific defaults (code cuts skew DAG-ish; conversation/argument cuts skew
   cluster-ish — a per-domain hint could bias the picker).
   **Ruling (4A review, 2026-07-06): accepted as drafted** — starting values
   stand, tuned in 4E. **No per-domain bias in v1** (that would build deferred
   material early).
2. **`V_max = 5000` cost guard.** Above it, `C` is skipped and the decision uses
   `backRatio` + `avgDeg` only. Confirm the bound (tie it to ADR-0014's node budget),
   or prefer always computing `C` on a bounded *sample* of nodes instead of skipping
   it wholesale.
   **Ruling (4A review, 2026-07-06): accepted as drafted** — `V_max = 5000`,
   tied to ADR-0014's scale; skip (not sample) above the bound.
3. **The messy-middle default (rule 6 → `d3-force`).** A sparse-but-cyclic cut that
   is neither cleanly layerable nor clustered falls to force. Confirm force is the
   right catch-all, or prefer `elk-layered` (which can layout cyclic graphs by
   breaking feedback edges) as the general default with force reserved for the
   explicitly cluster-ish rule 5.
   **Ruling (4A review, 2026-07-06): accepted as drafted** — force stays the
   messy-middle catch-all.
