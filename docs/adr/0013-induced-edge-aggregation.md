# ADR-0013 — Induced-edge aggregation: group by kind, sum weight, cap witnesses, exact ChangeSet invalidation

- **Status:** Proposed
- **Date:** 2026-07-05
- **Phase:** 3 (roadmap)
- **Constitution:** ARCHITECTURE.md §5.3, §5.5, §3.1 (Relationship taxonomy), §4.3 (portal rule); ADR-A3
- **Roadmap:** ROADMAP.md Phase 3 §5, §7, §8 (ADR-0013), §12 (perf)

## Context

When a cut hides detail, edges between hidden nodes must *aggregate*, not vanish
(§5.3): every base edge becomes a weighted, typed edge between the visible
ancestors of its endpoints, with multiplicity and sampled witnesses ("12 calls,
e.g. f→g"). This is the first potential perf cliff (roadmap §9b), so its caching
and invalidation are fixed now, not in P11. The roadmap fixes the output shape —
`InducedEdge { src, dst, kind, weight, multiplicity, samples: EdgeId[] }` — and
names the four decisions: grouping key, weight function, cap policy, and
ChangeSet-driven invalidation. This record makes each concrete.

## Decision

**Endpoint mapping.** Given a `Cut` (the visible antichain) and the space, for
each base edge `e = (u → v, kind K, weight w?)` let `A(x)` = the unique visible
ancestor of node `x` in the cut (every node maps to exactly one, by I5). Then:

- `A(u) = A(v)` (both inside one visible node): the edge is **internal** and is
  **excluded** from the induced set; its count is retained in that node's summary
  stats (surfaced by the deterministic summarizer, not as an induced self-loop).
- `A(u) ≠ A(v)`: the edge contributes to the induced edge `A(u) → A(v)`.

**Grouping key.** `(src = A(u), dst = A(v), kind = K)` using the edge's **declared
`kind` string verbatim** (e.g. `code:calls`), *not* collapsed to its core-taxonomy
mapping. Fidelity first: two different kinds between the same visible pair produce
two induced edges. Edges are **directed**; `A→B` and `B→A` are distinct. The
core-taxonomy mapping (§3.1) is available for a consumer that wants to further
roll up, and can be attached to `InducedEdge` additively later.

**Weight & multiplicity.** For each group:

- `multiplicity` = count of member base edges.
- `weight` = `Σ (e.weight ?? 1)` over members — sum of base weights, absent weight
  counting as `1`. For unweighted graphs `weight == multiplicity`.

Both are monotone and exactly reproducible by brute force (the 3C equivalence
test).

**Witness cap ("+n more").** `samples` holds at most `S = 3` member `EdgeId`s, the
`S` smallest by `EdgeId` ascending (deterministic, I6). `multiplicity` always
reflects the *true* count, so "+n more" = `multiplicity − samples.length`; no count
is ever lost, only the witness list is bounded.

**Fan-out cap (hub explosion).** Aggregation itself is **non-destructive** — it
returns every cross-pair induced edge, which is what the brute-force equivalence
test checks. A separate, explicitly-labeled truncation runs *after* aggregation
during `LodResult` assembly: if a visible node's induced out-degree (or in-degree)
exceeds `M` (`ZoomPolicy.budget`-configured, default `M = 32`), keep the top `M` by
`weight` (ties by `dst` then `kind`, ascending) and emit one synthetic residual
marker `"+k more"` carrying the summed residual `weight`/`multiplicity`. The full
uncapped set remains available (and is what the cache stores); capping is a
presentation hint, never a correctness claim.

**Determinism.** The returned induced-edge list is sorted by `(src, dst, kind)`
ascending; `samples` sorted by `EdgeId`. Same `(space, cut)` → byte-identical
result (I6).

**Portals / cross-graph references.** Cross-graph links live as intra-graph
reference edges to a boundary node (portal rule, §4.3); they aggregate exactly
like any other edge, so no special case is needed here.

**Cache & exact invalidation (§5.5).** The aggregation is cached at the
**visible-node** granularity, so a mutation touches only affected ancestors
(roadmap §12 asserts the op-count):

- Cache = `Map<NodeId /*visible A*/, InducedAdjacency>`, where each visible node
  owns its outgoing (and incoming) induced multiset keyed by `(dst, kind)`.
- A **cover index** maps every graph `g` in the space to the visible node `A`
  whose covering subtree contains `g` — derivable from the cut trace's per-node
  subtree set (ADR-0012). It is rebuilt when the cut changes (new version/state).
- On a committed `ChangeSet`, the invalidated set is exactly
  `{ cover(g) : g ∈ change.touched.graphs } ∪ { cover(graphOf(n)) : n ∈
  change.touched.nodes }`. Only those visible nodes' adjacencies are recomputed;
  every other entry is reused. If the intersection is empty (the change is under
  no visible node in this cut), the cached induced set is valid unchanged at the
  new version. Invalidation is **exact, not conservative** (§5.5), because the
  trace records dependencies.
- The whole cache is keyed by `(storeVersion, cutHash)` at the top level; a new
  cut rebuilds the cover index but may still reuse per-node adjacencies whose
  covered subtree is unchanged.

## Alternatives considered

- **Group by core-mapped kind.** Rejected as the default: it would merge
  `code:calls` and `code:imports` when both map to `references`, destroying
  domain fidelity. The mapping stays available for opt-in secondary rollup.
- **Emit induced self-loops for `A(u)=A(v)`.** Rejected: intra-node topology is
  the collapsed node's *internal* structure, better surfaced as a summary stat
  than as a self-loop that clutters every collapsed hub.
- **Destructive fan-out capping folded into aggregation.** Rejected: it would
  break the brute-force equivalence property and make caches lossy. Capping is a
  labeled, reversible presentation step over a complete aggregation.
- **Cache keyed only by `(version, cutHash)`, invalidate wholesale.** Rejected:
  fails the "touch only affected ancestors" perf gate — a one-node edit would
  rebuild the entire induced set.
- **Undirected aggregation.** Rejected for v1: the model's edges are directed;
  an undirected rollup is a lossy view a consumer can compute on top.

## Tradeoffs & consequences

- Verbatim-kind grouping can produce several parallel induced edges between a
  pair; the fan-out cap and per-kind sorting keep this bounded and deterministic.
- Per-visible-node caching costs a cover index rebuild whenever the cut changes,
  but buys exact, ancestry-scoped invalidation — the difference between passing
  and failing the perf gate on the 100k-node forest.
- Excluding internal edges means a collapsed node's inner density is only visible
  via its summary, not the induced graph — an intentional information *move*, not
  a loss.

## Reasoning

Grouping by kind is the coarsest key that still lets a human read "12 calls" vs
"3 imports"; summing weights is the only aggregation that is both associative
(incremental) and brute-force-checkable; capping witnesses rather than counts
preserves the true magnitude while bounding payload; and visible-node-granular
caching is the only structure under which §5.5's "invalidate exactly the
intersecting ancestry" is literally implementable against the P1 `ChangeSet`.

## Future implications

P4 layout and P5 rendering consume `InducedEdge` directly; the residual `"+k more"`
marker becomes a renderable summary edge. P6 transition planning diffs induced
edges across cuts using the same cache. P8 clustering changes the containment
forest through ordinary deltas, so induced edges re-aggregate with no new
machinery. The core-kind mapping and undirected rollups are additive extensions of
`InducedEdge` if a consumer needs them.

## Open questions for review

1. **Grouping granularity.** Verbatim `kind` (recommended, fidelity-first) vs
   core-mapped kind. Confirm.
2. **Witness cap `S = 3` and fan-out cap `M = 32`.** Reasonable defaults, both
   `ZoomPolicy`-tunable and re-tuned in P6. Confirm the values or the tunability.
3. **Internal edges dropped from the induced set.** Recommended; flagging because
   a domain that cares about intra-cluster density (e.g. argument maps) might want
   an opt-in self-loop instead.
