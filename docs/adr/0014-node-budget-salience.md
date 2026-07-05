# ADR-0014 — Node budget & salience v1: collapse lowest-salience subtrees, coverage wins over budget

- **Status:** Proposed
- **Date:** 2026-07-05
- **Phase:** 3 (roadmap)
- **Constitution:** ARCHITECTURE.md §5.1, §5.3, §3.1 (Metadata, `core:salience`), §3.2 (I5, I6), §8.1; ADR-A3
- **Roadmap:** ROADMAP.md Phase 3 §5, §7, §8 (ADR-0014), §12 (1M-leaves failure case)

## Context

A cut resolved purely from level + overrides can still be far too large for a
viewport (§5.1 lists a node budget as part of abstraction state; the roadmap's
1M-leaves-under-one-parent case must not explode). The resolver therefore accepts a
`Budget` and, when the cut exceeds it, degrades by **collapsing lowest-salience
subtrees** (roadmap §8). This record fixes the budget type, the degradation
algorithm, its interaction with overrides/focus (ADR-0012), the coverage-vs-budget
tie-break, and the **salience v1** function (size, degree, recency) named in §8.
The reserved `core:salience` attribute already exists (`graph-core/attrs.ts`); its
role is fixed here.

## Decision

**Budget type.** `Budget = { maxNodes: number }` (the `viewportHint` /
`ZoomPolicy.budget`). Edge budgeting is deferred to the fan-out cap of ADR-0013;
`maxNodes` is the only ceiling in v1.

**Degradation algorithm.** After the level+override cut is computed (ADR-0012), if
`|cut| > maxNodes`, greedily collapse until `|cut| ≤ maxNodes`:

1. A **collapse candidate** is an internal node `P` all of whose currently-visible
   descendants form a contiguous frontier `P` could replace (rolling the cut up one
   containment level at `P`). Collapsing replaces those `k` cut nodes with `P`,
   reducing the count by `k − 1`.
2. `P`'s collapse cost = the **minimum salience** among the cut nodes it would
   remove (collapsing away the least-salient region first).
3. Repeatedly collapse the candidate of lowest cost (a priority queue; ties by
   `NodeId` ascending for determinism, I6) until under budget or no candidate
   remains.

The 1M-leaves-under-one-parent case collapses in a single step (the parent
replaces all leaves at once), so degradation is roughly `O(cut · log cut)`, well
inside the perf gate.

**Protected from collapse.** Never collapse (a) a `pin`ned or `expand`ed node, (b)
any ancestor on the path to a pinned/expanded node, or (c) the `focus` node and its
containment path. Budget degrades the **context**, never the user's declared focus
— this is what makes focus+context survive a tight viewport (§5.6).

**Coverage wins over budget (best-effort).** Budget is satisfied only down to the
coarsest legal cut. If even the all-roots cut (with focus/pins forced open) still
exceeds `maxNodes`, the resolver **emits that cut and records `budget-exceeded` in
the trace** rather than dropping nodes — dropping would violate I5 (every leaf
covered exactly once). Coverage and focus-visibility are hard; budget is
best-effort.

**Salience v1.** `salience(n) ≥ 0`, computed per resolve over the collapse
candidates:

- **size** — subtree leaf-count under `n` (how much `n` stands in for).
- **degree** — `n`'s induced-edge degree at the current cut (ADR-0013);
  connectivity/hubness.
- **recency** — a per-node recency signal in `[0,1]` (see below); newer = more
  salient.

Each signal is **min-max normalized within the candidate set** for this resolve,
then combined:

```
salience(n) = w_size·size_norm + w_degree·degree_norm + w_recency·recency_norm
```

with **v1 default weights `w_size = 0.5`, `w_degree = 0.3`, `w_recency = 0.2`**. If
a signal is absent for the whole cut (e.g. no recency data), its term is dropped
and the remaining weights renormalized to sum to 1. These constants are frozen as
*mechanism* in P3 and re-tuned in P6 with the real camera (roadmap Phase 3 §9c).

**Recency source.** Recency is read from an optional numeric `core:updated-at`
attribute (epoch ms) on a node, taken over its subtree as the max; when the
attribute is absent across the cut, the recency term drops out (weights
renormalize). The pure resolver reads only the snapshot, so recency cannot come
from the op log; `core:updated-at` (or a request-supplied recency map) is the
only pure source. See Open questions.

**Explicit salience prior (`core:salience`).** When a node carries the reserved
`core:salience` attribute (a number; AI/user "this deserves emphasis," §8.1 —
AI is *advisory* on salience), that value **replaces** the computed structural
salience for that node (explicit intent wins). Absent the attribute, salience is
computed structurally as above. This gives the reserved key a concrete v1 meaning
without a new write path — it arrives as an ordinary tagged attribute.

**Trace.** Every budget-collapsed node is tagged `budget` in the `CutTrace`
(ADR-0012) with the losing salience value, so "why did this collapse?" is
answerable. `budget-exceeded` is recorded on the whole result when the ceiling
could not be met.

**Purity & determinism.** Given identical `(space, cut, budget, focus, overrides)`
the degraded cut is byte-identical (I6); all tie-breaks are `NodeId`-ordered.
Budget never violates I5 — collapsing a frontier up one level keeps a covering
antichain.

## Alternatives considered

- **Drop lowest-salience nodes to meet the budget.** Rejected: breaks I5 (a leaf
  goes uncovered) and hides data with no trace of where it went. We roll up, never
  delete.
- **Collapse cost = salience of `P` itself (not min of removed set).** Rejected:
  a high-salience parent of low-salience children would be protected wrongly; the
  cost of a collapse is what it *hides*, i.e. the least-salient removed region.
- **Recency from the op log / version stamps.** Rejected for the resolver: it is
  pure over a snapshot with no history. Recency enters as data (`core:updated-at`)
  or a request map.
- **`core:salience` as a multiplicative bias on the computed value.** Considered;
  rejected for v1 in favor of *replace*, which is simpler to reason about and
  matches "explicit emphasis overrides heuristics." Revisit if biasing proves more
  useful in P6/P8.
- **Budget over nodes *and* edges.** Deferred: edge pressure is handled by
  ADR-0013's fan-out cap; a second ceiling adds interaction complexity without a
  proven need in P3.

## Tradeoffs & consequences

- Min-salience collapse cost plus focus/pin protection means the budget always
  eats the periphery first and keeps the user's region intact — the correct feel,
  at the cost of a protected-set computation each degrade.
- Best-effort budget means a pathological cut can exceed `maxNodes`; consumers must
  handle an over-budget result (it is flagged), rather than assuming a hard cap.
- Per-resolve normalization makes salience relative to the current candidate set,
  so the *same* node can be collapsed in one cut and kept in another — intended
  (salience is contextual), but it means salience is not a stored global ranking.

## Reasoning

Rolling up (not deleting) is the only degradation that preserves I5 and stays
explainable. Size, degree, and recency are the three signals available headless
that correlate with "worth showing": how much a node summarizes, how connected it
is, and how fresh it is. Normalizing per resolve keeps the function scale-free
across wildly different graphs. Letting `core:salience` override wires the
constitution's advisory-AI-emphasis story (§8.1) into the mechanism now, through
the one write path, with zero special-casing.

## Future implications

P6 re-tunes the weights and the budget against the live camera and may add a
distance-to-focus salience term once focus-relative zoom exists. P8's AI
summarizer/analyst emits `core:salience` as tagged proposals, immediately biasing
budget without touching this code. P11 hydration reuses "cold detail counts as a
collapsed leaf," so cold subtrees are naturally low-cost to keep collapsed under
budget. Edge budgeting, if needed, is an additive second ceiling.

## Open questions for review

1. **Recency source.** `core:updated-at` attribute (recommended) vs a
   request-supplied `ReadonlyMap<NodeId, number>` recency channel vs dropping
   recency from v1 entirely. This is the one genuinely-open input — the model has
   no timestamp field today, and the resolver cannot read the op log. Confirm the
   attribute approach or pick an alternative.
2. **`core:salience` semantics.** Replace (recommended) vs multiplicative bias vs
   additive prior. Confirm.
3. **Default weights `0.5 / 0.3 / 0.2` and `Budget = { maxNodes }` only.**
   Confirm as v1 defaults (P6-tunable), and confirm deferring an edge budget.
