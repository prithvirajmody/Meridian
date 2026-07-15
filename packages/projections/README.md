# @meridian/projections

Headless view-projection contracts and built-ins. A projection chooses a
spatial metaphor and requests a capability-scoped medium from its host; it
never receives a DOM node, renderer, graph store, or application state store.

Phase 10B introduces the registry and behavior-preserving `MapProjection`.
The map delegates the existing `RenderModel` and camera view state to the
node-link surface owned by Studio/renderer integration. Phase 10C adds the
layout-optional `OutlineProjection`, which emits semantic virtual-list frames
through the host without importing DOM or renderer APIs.

Phase 10D–10E add the two canvas projections over the generic retained
2D-canvas medium port (`Canvas2dFrame` draw lists in, plain pointer/wheel/
resize data out):

- `MatrixProjection` — cluster-ordered adjacency matrix
  (`orderMatrixNodes`: containment groups, connected-component fallback,
  unconnected nodes trail; heavier nodes lead within a cluster). Cell clicks
  select canonical induced-edge keys; diagonal and gutter clicks select
  nodes; cuts without relationships degrade with a message. Row labels give
  way to cluster labels below the label-size threshold; column labels are a
  deliberate v1 omission (the ordering is symmetric, so rows identify
  columns).
- `TimelineProjection` — swimlanes for domains whose manifest declares
  temporal attrs (ADR-0037): lanes from the declared lane attribute, UTC
  axis ticks sized to the visible span, wheel-zoom about the cursor time,
  bar clicks select nodes. Atemporal domains and timeless cuts degrade with
  specific messages, never a crash.

Every projection implements the ADR-0036 lifecycle: identity selection/focus
applied verbatim, focus revelation, validated serializable view state with
deterministic fallback, and idempotent destroy.
