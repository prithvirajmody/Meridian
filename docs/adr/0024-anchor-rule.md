# ADR-0024 — Anchor rule: the world point under the cursor maps through the refinement, affine rect-to-rect, geometric fallback

- **Status:** Proposed
- **Date:** 2026-07-12
- **Phase:** 6 (roadmap)
- **Constitution:** ARCHITECTURE.md §5.4 (anchor preservation — "the Google-Maps rule"), §3.2 (I6); ADR-A3
- **Roadmap:** ROADMAP.md Phase 6 §3, §8 (ADR-0024), §11 (anchor pixel drift < 8px), §12

## Context

Geometric zoom-about-a-point already exists (`CameraController.zoomAt`, 5C).
Semantic zoom breaks it: at a threshold crossing the node under the cursor is
*replaced* — by its children (zoom-in) or its ancestor (zoom-out) — and their
rects in the incoming layout need not contain the old world point. The
constitution's rule: the world point under the cursor at a threshold crossing
is mapped through the refinement so the same *semantic location* stays under
the cursor after the cut swap (§5.4) — "this one rule is most of 'it feels
like Maps.'" This record fixes the anchor's definition, the exact mapping
math (as a pure function, testable by property), the camera solve, how the
correction is applied over the transition, and every fallback. The 8px drift
budget (roadmap §11) is the gate it must pass.

## Decision

**Anchor point.** For pointer gestures (wheel, pinch), the anchor
`A ∈ screen` is the pointer position at the instant the level change commits
(the hysteresis trigger fires, ADR-0012). For keyboard/programmatic zoom and
for budget/mutation-triggered cut changes, `A` is the viewport center.
`W = screenToWorld(A, camera_out)` — the anchored world point in the
*outgoing* frame.

**Anchor node.** `u` = the node in the outgoing cut whose rect contains `W`;
if several (layout overlap), the smallest by area; ties by ascending `NodeId`
(I6). If no rect contains `W`, and the nearest rect (Euclidean distance from
`W` to rect boundary) is within `ANCHOR_SNAP = 0.5·Λ` (ADR-0016's
characteristic length), that node is `u`; otherwise the anchor is **empty
space** → geometric fallback below.

**The mapping — affine rect-to-rect.** Let `R_out` = `u`'s rect in the
outgoing layout, and `R_in` = the bbox of `u`'s refinement image in the
incoming layout: its entering descendants (zoom-in), its covering ancestor's
rect (zoom-out), or its own incoming rect (u persists — a move). Express `W`
in normalized coordinates of `R_out` and re-emit at the same normalized
coordinates of `R_in`:

```
anchorMap(W, R_out, R_in) = R_in.origin + (W − R_out.origin) ⊙ (R_in.size / R_out.size)
```

with degenerate `R_out` extents (zero width/height) mapping to `R_in`'s
center on that axis. `anchorMap` is a pure function in
`@meridian/navigation`; the property test (roadmap 6B) is: for any cut pair
and any `W` inside `R_out`, the mapped point lies inside `R_in`, and
composing zoom-in with the corresponding zoom-out returns `W` up to the
rect-to-rect affine round-trip.

**Camera solve.** The incoming camera scale `s_in` is whatever the gesture
produced (the controller's scale↔z coupling, ADR-0025 — the anchor rule never
alters scale). The incoming center is solved so `W′ = anchorMap(W, …)` lands
on the same screen point: `worldToScreen(W′, camera_in) = A`, i.e.
`center_in = W′ − (A − viewport/2) / s_in` (per ADR-0015/`CameraState`
conventions). One equation, one unknown; no fitting, no search.

**Application over the transition.** The camera tweens `camera_out →
camera_in` along the shared easing on the same clock as the
`TransitionPlan` (ADR-0023) — camera and node tweens are one choreography, so
the anchored screen point holds *throughout* the flight, not just at the ends.
Anchor drift — `‖worldToScreen(anchorMap-interpolated W, camera(t)) − A‖` — is
the measured quantity gated at < 8px per transition (roadmap §11/6D). On
retarget (ADR-0023), the anchor is re-evaluated at the retarget instant with
the current pointer position; anchors never queue.

**Fallbacks (all located, never throw).**

- **Empty space** (no `u` within `ANCHOR_SNAP`): pure geometric anchoring —
  `W′ = W`, the 5C `zoomAt` behavior. Semantically empty pixels have no
  refinement to follow.
- **Anchor node removed** by a concurrent mutation (its `NodeId` is in
  neither cut nor the containment forest at plan time): geometric fallback,
  diagnostic recorded on the plan.
- **Crossfade-degraded transitions** (ADR-0023): the camera solve still
  applies — anchoring is a camera property, not a per-node animation, so even
  a crossfade holds the point under the cursor.
- **Drill-in/out** (ADR-0025): context changes do not anchor to the cursor;
  they frame the new context (that ADR's rule). The anchor rule governs
  continuous zoom only.

## Alternatives considered

- **Anchor to the node center** (fly the camera so `u`'s image centers under
  the cursor). Rejected: discards *where inside* the node the user was
  pointing — visibly wrong on large rects; the affine map preserves it.
- **Nearest-point mapping** (`W′` = nearest point of `R_in` to `W`).
  Rejected: collapses distinct anchor points onto edges, so consecutive
  zooms at slightly different pointer positions land identically — feels
  sticky and wrong.
- **Screen-space correction after the swap** (snap camera at the end instead
  of tweening with the plan). Rejected: the anchor visibly slides mid-flight
  and snaps at the end; the drift budget is per-transition, not per-endpoint.
- **Anchoring budget/mutation-triggered cut changes to the pointer.**
  Rejected: the pointer is semantically unrelated to a change the user did
  not gesture; viewport center is the honest anchor.
- **Scale participation** (adjusting `s_in` to fit `R_in` on screen).
  Rejected: the gesture owns scale; an anchor rule that changes zoom speed
  makes the input feel broken. Fitting is drill-in's job (ADR-0025).

## Tradeoffs & consequences

- Buys: one pure function + one closed-form camera solve implements the
  constitution's signature feel rule; property-testable headless (point under
  cursor maps through refinement — roadmap 6B) before any animation exists.
- Costs: the choreographer/controller must thread the pointer position at
  trigger time into planning; `Λ` (ADR-0016) becomes a navigation-side
  dependency for the snap radius.
- Anchoring to the *smallest containing rect* means compound/containers
  under overlap resolve to the most specific child — matches pointing
  intuition, but hit-testing must match ADR-0021's picking order exactly or
  hover and anchor will disagree about "what's under the cursor."

## Reasoning

Maps feels right because the point under your finger never moves. The
semantic analogue must survive the anchor's *object* being replaced, so the
rule follows the refinement (the semantic location) rather than raw geometry.
The affine rect-to-rect map is the simplest correspondence that preserves
"where inside the thing I was pointing"; the closed-form center solve is the
whole camera computation; making both pure keeps the 6B property tests and
the 8px CI gate meaningful (I6: same inputs, same camera, no wall-clock or
renderer state in the math).

## Future implications

`anchorMap` is reused by fly-to (6C: search targeting is a degenerate anchor
at viewport center) and later by P12 camera-follow (a peer's anchor replayed
through the same map). If P10 projections define their own geometry, each
projection supplies its `R_out/R_in` correspondence and inherits the rule.
`ANCHOR_SNAP` joins the 6E tunable-constants panel.

## Open questions for review

1. **Empty-space snap radius.** `ANCHOR_SNAP = 0.5·Λ` (half a typical
   neighbor-gap) is proposed so near-misses on dense cuts still track the
   obvious node. Alternative: no snapping — any miss is geometric. Recommended
   as specified; flag if you prefer the stricter reading.
2. **Center-anchored programmatic zooms.** Confirm viewport-center anchoring
   for keyboard/slider/budget-triggered changes, or prefer anchoring to the
   current `focus` node's center when one exists (slightly smarter, slightly
   less predictable).
