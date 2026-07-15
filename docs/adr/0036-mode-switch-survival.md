# ADR-0036 — Mode-switch survival: identity always, geometry only when compatible

- **Status:** Accepted
- **Date:** 2026-07-15
- **Phase:** 10 (roadmap)
- **Constitution:** ARCHITECTURE.md §9.4 (mode switches), §10.3–10.5 (interaction state and selection), §12.1 (view/session state), §20 (dependency law); ADR-0023, ADR-0025
- **Roadmap:** ROADMAP.md Phase 10 §1, §5–§8, §11–§12
- **Numbering:** Accepted Phase-8 amendment ADR-0035 occupies the next sequential number; the previously reserved Phase-10…12 numbers therefore move forward by one (0036…0044).

## Context

Phase 10 lets one semantic cut render as a node-link map, outline, adjacency
matrix, or timeline. A mode switch crosses rendering media and geometric
metaphors, but it must not change what the user selected or what they are
focused on. The constitution already fixes the principle: selection and focus
survive every switch, camera survives only between compatible geometries, and
other switches preserve focus visibility.

The working code is richer than the roadmap's illustrative selection sketch.
`@meridian/view-model` already defines a structured-cloneable
`SelectionState` with node identities, edge identities, and an optional
node-or-edge anchor. Navigation already owns the focus node through
`NavigationController` / `NavContext`, mirrored into Studio state. Replacing
either with a second Phase-10 authority would be a regression, not a
formalization.

This record fixes the state-survival matrix, the switch transaction, in-flight
transition behavior, per-projection state, and failure fallback.

## Decision

### Identity state survives every switch

The existing `SelectionState` is the canonical selection contract. Phase 10
may export the shorter name `Selection` as an alias, but it must preserve the
existing shape and semantics:

```ts
interface SelectionState {
  readonly nodes: readonly NodeId[];
  readonly edges: readonly string[];
  readonly anchor?:
    | { readonly kind: 'node'; readonly id: NodeId }
    | { readonly kind: 'edge'; readonly key: string };
}
```

Selection is identity-based and independent of visibility. A node hidden by a
cut or a projection remains selected; the projection may show a containment or
row/column cue instead of inventing another selection. Edge selection and an
edge anchor remain supported, including in the matrix.

Navigation remains the sole focus authority. Phase 10 formalizes a
presentation-neutral focus value derived from the active `NavContext`; it does
not create a competing focus store. The focus identity survives every switch
and fallback. If graph repair invalidates it, the existing navigation repair
rules choose the replacement before a projection consumes it.

### A switch is one contained transaction

Studio, as the composition root, performs a switch in this order:

1. snapshot selection, focus, and the active projection id;
2. capture the outgoing instance's serializable view state;
3. if navigation is mid-transition, cancel visual interpolation and publish
   its already-chosen semantic target model/camera — the intent completes, the
   animation does not resume later;
4. asynchronously mount the requested projection in a staged host;
5. restore that projection's prior validated state, when one exists;
6. apply the unchanged selection and focus, then make the focus visible; and
7. publish the new active projection only after the instance is ready.

No step mutates graph state. Projection choice is view/navigation state, never
an edit-history operation. A switch may emit diagnostics and a navigation
event, but it may not emit a graph delta.

The host ignores stale completion from an older switch generation. Rapid
switches therefore converge on the final requested projection rather than
mounting out of order.

### Geometry transfers only where it has meaning

Raw camera state crosses a switch only between geometrically compatible
node-link map instances. It never becomes outline scroll position, matrix pan,
or timeline offset.

Each projection instead owns a separate, serializable view-state snapshot per
View and projection id. Returning to a projection restores its own state:

- map: camera and map-local presentation state;
- outline: scroll/window and keyboard-active row;
- matrix: row/column viewport and ordering state; and
- timeline: time window, lane viewport, and ordering state.

After restoration, focus visibility wins over an exact stale viewport. A map
centers or reveals the focused node; outline scrolls its row into view; matrix
reveals its row/column; timeline reveals its interval. With no node focus, the
node selection anchor is the fallback visibility target; with neither, the
projection uses its own deterministic default view.

Captured state must be structured-cloneable data. The owning projection
validates it on restore. Missing, stale, malformed, or throwing state is
discarded with a diagnostic and the projection's default state; it cannot
abort the switch. Phase 10 keeps this state in memory, shaped for the View
persistence added in Phase 11.

### Faults fall back atomically

The host contains failures from `mount`, initial `render`, state restoration,
selection/focus application, or focus revelation. A partial target instance is
destroyed, a located diagnostic is emitted, and `MapProjection` is mounted with
the original selection and focus. The active id becomes `map`, not the failed
id. Fallback must meet the same focus-visibility rule.

If the map fallback itself cannot mount, the host shows a deterministic DOM
failure message and keeps the identity state in Studio. It does not recurse or
white-screen.

Suitability orders the menu but never silently forbids a choice. An atemporal
timeline or otherwise unsuitable projection renders a specific degraded
message while preserving selection/focus and the ability to switch away.

## Alternatives considered

- **Preserve every projection's coordinates across every switch.** Rejected:
  camera, scroll, matrix cells, and time windows are not equivalent geometries;
  pretending they are creates arbitrary motion. Focus visibility is the shared
  invariant.
- **Replace `SelectionState` with `Set<NodeId>`.** Rejected: `Set` is not the
  existing public shape and would drop edge selection and edge anchors.
- **Let each projection own selection/focus.** Rejected: identity would diverge
  across modes and a failed mount could lose session state.
- **Queue a projection switch behind an animation.** Rejected: it makes a mode
  control feel unresponsive and creates ordering races. Semantic navigation
  completes; visual interpolation is cancelled.
- **Crash or remain blank when a projection fails.** Rejected by the roadmap's
  explicit map-fallback requirement and the renderer degradation discipline.

## Tradeoffs & consequences

The transaction and generation guard add lifecycle machinery, and restoring a
projection can move its saved viewport to reveal focus. In exchange, the user
never loses identity state, rapid switches are deterministic, transition races
are bounded, and failure is observable without destroying the session.

Every built-in and plugin projection must implement state validation and focus
revelation. Property tests over random projection sequences become the durable
oracle for this record; the 4×3 Playwright matrix exercises the same contract
through real media.

## Reasoning

Selection and focus answer semantic questions (“what?” and “where in the
graph?”); camera and scroll answer projection-specific geometric questions
(“how is this mode framed?”). Keeping identity in the session/navigation layer
and geometry in per-projection View state follows the constitution's state
strata and gives every future projection one unambiguous survival rule.

## Future implications

Phase 11 can persist the already-serializable per-View projection snapshots.
Phase 12 presence can transmit identity plus a projection id without pretending
that two peers in different modes share coordinates. Multi-pane dashboards,
when eventually designed, reuse the same per-View/per-projection keys rather
than sharing one global camera.

## Phase 10A ruling (2026-07-15)

Accepted as written: the state-survival matrix and transactional switch order;
“semantic target completes, visual interpolation cancels” for a switch issued
mid-transition; and the forward-only ADR-number cascade caused by accepted
ADR-0035.
