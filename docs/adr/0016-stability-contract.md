# ADR-0016 — Stability contract: normalized displacement, a scored [0,1] number, gated at 0.90

- **Status:** Proposed
- **Date:** 2026-07-06
- **Phase:** 4 (roadmap)
- **Constitution:** ARCHITECTURE.md §5.4 (hysteresis/anchors, "nodes must not teleport"), §5.5, §3.2 (I6); ADR-A3
- **Roadmap:** ROADMAP.md Phase 4 §2, §8 (ADR-0016), §11, §12

## Context

Re-layout after a small change must not teleport the nodes that did not change
(§5.4; roadmap §2: "nodes must not teleport on small changes"). The roadmap makes
this a *number*: `LayoutResult.stability: number`, "a scored, tested, CI-gated
number" (§8, §11; subphase 4D: "stability is a scored, CI-gated number ≥ threshold
on scripted small-delta sequences"). This record fixes (a) the per-node tolerance
ε and what it is measured *relative to*, (b) the exact `stability ∈ [0,1]` formula,
(c) what counts as a "small delta," (d) how added/removed nodes are handled, and
(e) the gate threshold. Providers achieve stability by mechanism — elk via position
hints, force via warm-start from `prev` (§8) — but the *score* is a pure function
of `(prev, current)`, so CI recomputes it and a provider cannot self-report a lie.

## Decision

**Persistent set.** `P = keys(prev.positions) ∩ keys(current.positions)` — the
nodes present in both layouts. Stability is defined only over `P`.

**Characteristic length `Λ` (the scale ε is relative to).** ε is expressed
relative to a **local** scale, not raw world units (not scale-invariant) and not
the bounds diagonal (which grows with node count, making ε absurd on big graphs).
`Λ = median center-to-center distance over `prev`'s induced edges`, with fallbacks
`LayoutHints.spacing` when `prev` has no edges, and `1` when spacing is unset. `Λ`
is "the typical gap between neighbors," so displacement can be read as "how many
neighbor-gaps did this node move."

**Per-node normalized displacement.** For `n ∈ P`,
`d̂(n) = ‖center_current(n) − center_prev(n)‖₂ / Λ` (Euclidean, on `Rect` centers
per ADR-0015).

**Per-node tolerance ε.** `ε = 0.5` (dimensionless, i.e. half of `Λ`). A node is
**"held"** iff `d̂(n) ≤ ε` — it moved less than half a typical neighbor-gap, which
reads as "stayed put." ε is per-node; the *score* below is aggregate.

**Stability score (the `LayoutResult.stability` field).**

```
k(x)      = clamp(1 − x / D, 0, 1),   with D = 4          // graded, not pass/fail
stability = (1/|P|) · Σ_{n∈P} k(d̂(n))                     // mean per-node stability
stability = 1                          when |P| = 0        // vacuously stable
```

`k` is a linear ramp: a node that did not move scores `1`; one that moved a full
`D = 4` neighbor-gaps (across several neighbors — a teleport) scores `0`; in
between it is graded linearly. The score is the mean, so `stability ∈ [0,1]`,
deterministic, and `1.0` for a first-ever layout (`prev` undefined ⇒ `P = ∅` ⇒
nothing could have moved).

**Added / removed nodes.** A node in `current` but not `prev` (added by the delta)
had no prior position and is **excluded from `P`** — it is not penalized for
"moving." A node in `prev` but not `current` (removed) simply drops out. Add/remove
still influences the score **indirectly**: the structural change may push
persistent nodes, and that motion *is* captured through their `d̂`. The scorer
therefore measures only persistent-node motion; churn enters only via its effect on
what stayed. Alongside `stability` the scorer reports `{ persisted: |P|, added,
removed }` for diagnosis (not gated, informational).

**"Small delta."** The contract *gates* only in the small-delta regime. A delta is
**small** when `added + removed ≤ max(10, 0.05 · |prev cut|)` (the `10` mirrors the
roadmap's "10-node delta" incremental test, §12/4D). A **large** delta (a coarse
zoom step, a big edit) is exempt from the gate — a major structural change is
*allowed* to reflow; its `stability` is still computed and reported, just not
CI-gated. Smallness is a property of the scripted delta the harness feeds, not of
the score.

**Gate threshold.** On scripted **small-delta** sequences, the CI gate is
**`stability ≥ 0.90`**, applied to the providers that have a stability mechanism —
**`elk-layered`** (position hints) and **`d3-force`** (warm-start from `prev`). The
threshold value is frozen here as *mechanism* and re-tuned in 4E against real
corpus SVGs (as ADR-0012 froze `h`/thresholds as mechanism and deferred tuning).
Its numeric home is `benchmarks/budgets.json` as a floor
(`layout-stability-small-delta-min = 0.90`), consistent with §5.2 ratchet-only
budgets.

**Fallbacks are exempt.** `grid` and `tree` are deterministic-by-construction and
have **no** position-hint / warm-start mechanism: inserting a node can legitimately
re-pack a whole grid or re-index a whole tree, so their stability under insertion is
expectedly low. They still *report* a stability number (the same formula), but they
are **not gated** on the ≥ 0.90 floor — they are trivial fallbacks, not stability
providers.

**Provider mechanisms (informative, implemented in 4D/4E).**
- **elk-layered:** feed each persistent node's `prev` position as an ELK
  interactive position hint (`org.eclipse.elk.position` + interactive strategy) so
  ELK perturbs minimally around prior placement.
- **d3-force:** initialize the simulation from `prev` positions (not random) and
  run with reduced `alpha`, so persistent nodes settle near prior spots; the seeded
  PRNG (ADR-0018) keeps it deterministic.

**Purity.** `stabilityScore(prev, current, hints) → { stability, persisted,
added, removed }` is a pure function (§3.2, I6): CI computes it independently and
asserts it equals the provider's reported `stability`, so `LayoutResult.stability`
is verifiable, not trusted.

## Alternatives considered

- **ε in raw world units.** Rejected: world units are arbitrary and scale with the
  graph, so a fixed ε is meaningless across cuts.
- **ε relative to bounds diagonal.** Rejected: the diagonal grows with node count,
  so the same absolute jiggle scores very differently on a 10-node vs 10k-node cut;
  neighbor-gap `Λ` is the scale a human actually perceives as "moved."
- **Boolean pass/fail per node (`d̂ ≤ ε`), score = fraction held.** Rejected as the
  *score* (kept as the per-node ε notion): a step function makes the CI gate
  brittle at the boundary and hides *how far* unstable nodes moved; the linear ramp
  `k` grades gracefully. (The ε concept is retained for the human-readable "held"
  count.)
- **Gaussian kernel `exp(−d̂²/2σ²)`.** Rejected: smooth but non-zero everywhere
  (a teleport never scores exactly 0) and less legible than a clamped ramp.
- **Penalizing added/removed nodes.** Rejected: an added node has no prior position;
  scoring it as "moved" would conflate legitimate growth with instability.
- **Gating grid/tree.** Rejected: they have no hint mechanism; gating them would
  forbid honest re-packing and defeat their role as always-available fallbacks.

## Tradeoffs & consequences

- Buys: one dimensionless, scale-invariant, provider-agnostic number that a human
  and CI read the same way; a pure scorer that closes the "provider lies about its
  own stability" loophole; a clean exemption boundary (small vs large delta) so the
  gate never fires on intended reflow.
- Costs: `Λ` needs `prev`'s edges (median over edge lengths) — a small extra pass;
  the small/large boundary is a chosen constant that 4E may need to re-tune per
  domain.
- The gate lives on the two real engines; the fallbacks' instability is documented
  and accepted, which means the default-provider heuristic (ADR-0018) should avoid
  routing incrementally-edited views to `grid`/`tree` when stability matters.

## Reasoning

"Don't teleport" is only enforceable if it is a measured number with a threshold
(§5.4, roadmap §11). Normalizing by the neighbor-gap makes the number match human
perception and hold across graph scales; the linear ramp makes it a smooth CI
signal; excluding add/remove from `P` while keeping their *effect* on persistent
nodes measures exactly the thing that matters — did the stuff that stayed, stay?
Purity of the scorer is what lets 4D assert `LayoutResult.stability` rather than
trust it.

## Future implications

The pure `stabilityScore` is exactly the input P6's `TransitionChoreographer`
needs when it decides move-vs-crossfade (anchor preservation, §5.4): a low
stability score across a cut change is the signal to degrade to crossfade rather
than tween teleporting nodes. `Λ` (characteristic neighbor-gap) is reusable as the
transition's spatial scale. Freezing the threshold as mechanism now, tuned in 4E,
mirrors the ADR-0012 pattern so the constant has one authoritative home.

## Open questions for review

1. **Threshold value `0.90` and ramp cutoff `D = 4`.** Both are proposed as
   mechanism, to be re-tuned in 4E against real corpus SVGs. Confirm the initial
   values, or set different starting points (e.g. a stricter `0.95` for elk, whose
   hints are strong, and a looser floor for force).
   **Ruling (4A review, 2026-07-06): accepted as specified** — a single `0.90`
   floor for elk and force alike; no split thresholds unless 4E tuning shows a
   need. `D = 4` stands.
2. **Normalization scale `Λ`.** Proposed: median neighbor-gap in `prev`. Alternative
   flagged for the reviewer: a hybrid `Λ = max(median neighbor-gap, k · median node
   size)` so degenerate/edge-free-ish cuts still get a sane scale. Recommended as
   specified (with the `hints.spacing` fallback) unless a corpus fixture shows the
   edge-length median is unstable.
   **Ruling (4A review, 2026-07-06): accepted as specified** — median
   neighbor-gap with the `hints.spacing` fallback; no hybrid.
3. **Small-delta boundary `max(10, 0.05·|prev cut|)`.** Confirm, or prefer a purely
   absolute (`≤ 10`) or purely relative (`≤ 5%`) definition. The gate's behavior on
   the boundary between "small" and "large" deltas is the one place this contract is
   genuinely tunable per domain.
   **Ruling (4A review, 2026-07-06): accepted as specified** —
   `max(10, 0.05·|prev cut|)`; numeric home in `benchmarks/budgets.json` as
   proposed.
