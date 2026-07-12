# @meridian/navigation

Phase 6's pure, headless semantic-zoom navigation planners.

Subphase **6B** ships the deterministic core, before any animation runs:

- **`deriveRefinementMap(fromCut, toCut, space)`** — the cut-diff
  correspondence (`move` / `enter` / `exit`), derived from containment per
  ADR-0023. Sourceless/targetless nodes are legal and diagnosed.
- **`TransitionChoreographer.plan(from, to, refinement)`** (and the free
  `planTransition`) — an inspectable `TransitionPlan`: `NodeAnim` spawn/merge
  geometry, `mode` (`choreographed` | `crossfade`), `durationMs`, and
  diagnostics that name any degrade trigger (ADR-0023).
- **Anchor math** (ADR-0024): `selectAnchorNode`, `anchorMap` /
  `affineRectMap`, and the closed-form `solveCameraCenter` — plus
  `solveAnchoredCamera` composing them for one threshold crossing.

Everything is pure (I6): no `Date.now`, no `Math.random`, no wall clock, no
renderer state. Constants (`BASE_TRANSITION_MS`, `MAX_ANIMATED_NODES`,
`ANCHOR_SNAP_FACTOR`, …) are exported for the 6E debug panel.

Dependency law (§20): imports `@meridian/abstraction` and
`@meridian/view-model` only.

**Not here** (6C/6D): NavigationController, hysteresis state machine, override
map, drill-in stack / `NavContext`, URL codec, search, keyboard navigation, any
animation player/renderer/Studio wiring.
