# ADR-0023 — Transition model: pure choreographed plans, one shared easing, 300ms/45fps hard budget, degrade-to-crossfade

- **Status:** Accepted
- **Date:** 2026-07-12
- **Phase:** 6 (roadmap)
- **Constitution:** ARCHITECTURE.md §5.4 (transitions), §1.4, §16.1 (≤300ms plan-to-settle, ≥45fps during), §3.2 (I6); ADR-A3
- **Roadmap:** ROADMAP.md Phase 6 §3, §5, §7, §8 (ADR-0023), §11, §12

## Context

A cut change (zoom threshold crossing, expand/collapse, budget kick-in, store
mutation) swaps one antichain for another. The constitution fixes the shape:
transitions are planned by a **pure choreographer** — cut-diff →
enter/exit/move sets → animation plan — with children spawning from parent
rects, exiting merges collapsing into their ancestor, moves tweening, and a
hard budget: *a transition degrades to cross-fade before it degrades frame
rate* (§5.4; §16.1: ≤ 300ms plan-to-settle, ≥ 45fps during). This record fixes
the plan data structure, the correspondence geometry, the easing and duration
constants, the exact degrade rule (plan-time and runtime), interruption
semantics (retarget, replan), and how time is injected so every plan is
testable headless. Anchor preservation is ADR-0024; drill-in is ADR-0025.

## Decision

**RefinementMap.** For a cut change `from → to` over one containment forest,
the refinement correspondence is derived (never stored) from containment:

- `move` — node in both cuts (same `NodeId`).
- `enter` — node only in `to`. Its **source** is its nearest ancestor in
  `from` (refinement) or, failing that, the bbox of its descendants in `from`
  (coarsening under overrides). No ancestor and no descendants ⇒ sourceless.
- `exit` — node only in `from`. Its **target** is its nearest ancestor in `to`
  (coarsening) or the bbox of its descendants in `to` (refinement), else
  targetless.

Because both cuts are covering antichains (I5), every entering/exiting node
has at most one such ancestor; ties cannot occur. Derivation is a pure
function of `(fromCut, toCut, space)`; sourceless/targetless nodes are legal
(e.g. subtree added/removed by a delta) and recorded in the plan diagnostics.

**TransitionPlan.** `TransitionChoreographer.plan(from: {cut, layout}, to:
{cut, layout}, refinements) → TransitionPlan` is a pure function (I6):

```ts
interface TransitionPlan {
  mode: 'choreographed' | 'crossfade';
  enter: NodeAnim[]; exit: NodeAnim[]; move: NodeAnim[];
  durationMs: number;                    // ≤ MAX_TRANSITION_MS
  diagnostics: PlanDiagnostic[];         // sourceless nodes, degrade reason, counts
}
interface NodeAnim { id: NodeId; fromRect: Rect; toRect: Rect; fadeIn?: true; fadeOut?: true; }
```

Geometry: an **enter** node tweens from its source's `from`-layout rect
(anchored affine: the child's final rect mapped back into the parent rect's
normalized coordinates) to its `to`-layout rect, alpha 0→1. An **exit** node
tweens from its `from` rect to its target's `to`-layout rect, alpha 1→0. A
**move** node tweens rect→rect. Sourceless enters fade in at their final rect;
targetless exits fade out in place. Labels do not tween independently; they
follow their node and respect ADR-0020 tiers at the *target* camera, fading in
during the final 30% so mid-flight text never pops.

*(Amended during 6B: move entries displaced ≤ ε·Λ — "held" in ADR-0016's terms
— are omitted from the plan entirely, consistent with the degrade predicate
counting only displaced moves; an identical-cuts/identical-layouts change
therefore yields a truly empty plan. `TransitionFrame` additionally carries an
optional `hints?: LayoutHints` so Λ's spacing fallback is available when a
layout emits no `edgeRoutes`.)*

*(Amended during 6D: the pixel path for fades is a pair of **optional**
per-node/per-edge alpha lanes on `RenderModel` (`nodeAlphas`/`edgeAlphas`) —
present only on transition frames; `buildRenderModel` never emits them, so
the view-model contract is unchanged for static frames. Incoming-cut **edges**
fade in with the eased progress (edge routes are target-layout truth; this
record was silent on edges). A crossfade draws the **union** of both frames —
nodes present in both cuts appear once per frame set and blend at
approximately constant alpha, avoiding a mid-fade dip.)*

**One shared easing.** `easeInOutCubic` for every animated property — rects,
alpha, and the camera path (ADR-0024). One curve is a feel decision: mixed
easings read as jitter. It is a named constant in the 6E debug panel.

**Duration.** `durationMs = BASE_TRANSITION_MS = 240` (tunable, frozen in 6E),
clamped so plan computation + animation ≤ `MAX_TRANSITION_MS = 300`
plan-to-settle (§16.1). Plan computation itself must run < 20ms on 5k-node cut
diffs (roadmap §12) — the plan budget is part of the 300, not extra.

**Degrade-to-crossfade — plan-time (pure, primary).** `mode: 'crossfade'`
(whole outgoing frame fades into incoming frame, no per-node tweens, duration
`CROSSFADE_MS = 160`) when any of:

1. `|enter| + |exit| + |move|` (moves counted only if displaced > ε·Λ,
   ADR-0016 terms) exceeds `MAX_ANIMATED_NODES = 1500` (tunable) — the
   predicted-cost proxy for "cannot hold 45fps";
2. more than 50% of enter+exit nodes are sourceless/targetless — there is no
   meaningful spawn geometry to choreograph;
3. `stabilityScore(from.layout, to.layout) < 0.5` (ADR-0016's pure scorer) —
   move targets are teleports; tweening teleports looks worse than a fade.

The triggering rule is recorded in `diagnostics` — a degraded transition
always says why (§5.1 spirit: feel bugs are inspectable data).

**Degrade — runtime (guard, secondary).** The player (renderer side) watches
frame time; if 3 consecutive frames exceed 22ms mid-flight, it abandons
per-node tweens and completes as a ≤100ms fade from the current frame to the
final state. This guard is measured in 6D's FPS harness but is expected to
fire rarely — plan-time prediction is the contract; the guard is the backstop
that makes "never drops below 45fps" literally true.

**Interruption — retarget, never queue.** A new target cut/camera arriving
mid-flight replans from the *current interpolated state*: the player snapshots
current rects/alphas, and those become the `from` geometry of the new plan
(the choreographer accepts any `{cut, layout}`-shaped from-state, so this is
the same pure call). Plans never queue; there is at most one in flight. A
committed store mutation mid-transition (P1 subscription) is the same case:
resolve the new cut, replan from current state.

**Time is injected.** The choreographer emits durations, not timestamps; the
player advances on an injected clock (`now()` provider). Studio injects
`performance.now`; unit tests and Playwright inject a scripted deterministic
clock (roadmap 6D mid-transition screenshot baselines depend on this).
Nothing in `@meridian/navigation` reads wall time (I6).

**Dependency law.** Choreographer, RefinementMap, and plans live in
`@meridian/navigation` (deps: `abstraction`, `view-model` — §20); the player
that samples plans into per-frame `RenderModel`/camera values sits with the
renderer bridge per ADR-0022 and never enters React's draw path.

## Alternatives considered

- **Spring/physics animation.** Rejected: no fixed settle time (violates the
  300ms budget), nondeterministic-feeling, and untestable against screenshot
  baselines with an injected clock.
- **Per-property easings (position vs alpha).** Rejected: reads as jitter;
  one curve is the smallest thing that looks intentional.
- **Queue transitions and play them in order.** Rejected by the roadmap's
  failure case ("must retarget, not queue"): queued plans mean the view
  answers gestures from the past.
- **Runtime-only degradation (no plan-time predicate).** Rejected: the first
  frames of an over-budget transition would still jank, and the rule would be
  unobservable in headless tests. Plan-time prediction makes degrade a pure,
  unit-testable decision.
- **Animating the label layout independently.** Rejected: doubles the
  animated-property surface for negligible feel gain; labels follow nodes.

## Tradeoffs & consequences

- Buys: feel bugs become inspectable `TransitionPlan` values before any pixel
  moves (roadmap §9a); deterministic replay under an injected clock; a hard,
  CI-gateable budget (§12: transition p95 frame time ≤ 22ms).
- Costs: retargeting requires the player to expose its interpolated state in
  world terms; the crossfade thresholds (`1500`, `0.5`, `50%`) are three more
  constants for the 6E tuning gate.
- Counting only displaced moves in the degrade predicate means a large cut
  where almost nothing moves still choreographs — intended: cost scales with
  animated nodes, not cut size.

## Reasoning

Every constraint above already exists in the constitution; this record only
makes them mechanical. Purity (plan as value) is what turns "feel" into
fixtures; the plan-time degrade rule is what makes the frame-rate promise a
*decision* rather than a hope; retarget-from-current-state is the only
interruption semantics that keeps the gesture and the view causally connected;
injected time is what lets Playwright photograph the middle of an animation.

## Future implications

The plan format is the seam P10 projections reuse (outline/matrix transitions
can consume enter/exit/move sets with different geometry). P12 presence can
broadcast plans as values. The ADR-0016 scorer becoming a degrade input closes
the loop promised in that ADR's future implications. Constants
(`BASE_TRANSITION_MS`, `MAX_ANIMATED_NODES`, easing) are frozen as mechanism
here and re-tuned at the 6E human gate — the ADR-0012 pattern.

## Open questions for review

1. **Degrade thresholds.** `MAX_ANIMATED_NODES = 1500`, stability floor `0.5`,
   sourceless majority `50%` are proposed as starting mechanism for 6E tuning.
   Confirm as initial values, or set different ones.
   **Ruling (6A review, 2026-07-12): accepted as specified** — initial
   mechanism values, re-tuned at the 6E human gate.
2. **Runtime guard shape.** Proposed: 3 consecutive >22ms frames → ≤100ms
   finish-fade. Alternative: no runtime guard at all (trust plan-time
   prediction; simpler player). Recommended as specified — the budget is a
   constitutional promise (§16.1) and the guard is what makes it
   unconditional.
   **Ruling (6A review, 2026-07-12): accepted as specified** — the guard
   stays.
