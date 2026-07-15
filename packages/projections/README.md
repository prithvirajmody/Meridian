# @meridian/projections

Headless view-projection contracts and built-ins. A projection chooses a
spatial metaphor and requests a capability-scoped medium from its host; it
never receives a DOM node, renderer, graph store, or application state store.

Phase 10B introduces the registry and behavior-preserving `MapProjection`.
The map delegates the existing `RenderModel` and camera view state to the
node-link surface owned by Studio/renderer integration. Phase 10C adds the
layout-optional `OutlineProjection`, which emits semantic virtual-list frames
through the host without importing DOM or renderer APIs.
