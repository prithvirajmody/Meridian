# ADR-0022 — React/canvas boundary: zustand value bridge, no draw calls from React

- **Status:** Accepted
- **Date:** 2026-07-11
- **Phase:** 5 (roadmap)
- **Constitution:** ARCHITECTURE.md §1.3 (Presentation/Interaction), §9.1, §10.3, §13.3, §20; ADR-A8
- **Roadmap:** ROADMAP.md Phase 5 §3, §5–§8, §10–§12

## Context

Studio must compose ingest → store → abstraction → layout → view-model → pixels,
show selected attributes/provenance in React chrome, and keep high-frequency
canvas work outside React reconciliation. At the same time, the renderer may not
read `graph-store`, React may not issue draw calls, and no Pixi/GPU object may
become the only copy of state. ADR-0015 also left a binding Phase-5 obligation:
move the geometry/Layout-I/O type definitions into `@meridian/view-model` and
replace layout's temporary direct abstraction/core dependency with view-model.

This record fixes the value crossing each boundary, package dependencies, store
ownership, event direction, lifecycle, and the exact mechanical checks.

## Decision

**The waist is a serializable `RenderModel`.** Subphase 5B creates
`@meridian/view-model` and moves (not copies) `Point`, `Size`, `Rect`,
`LayoutHints`, `LayoutInput`, `LayoutResult`, and related Layout-I/O definitions
out of `@meridian/layout`. Layout re-exports those public types for source
compatibility but imports their definitions from view-model. All layout source
imports of `Cut`, `InducedEdge`, and `NodeId` are repointed through view-model or
replaced with derived/type casts; its direct `layout → abstraction` and
`layout → graph-core` permissions are removed from dependency-cruiser. This
closes ADR-0015's time-boxed waypoint in 5B, before renderer code starts.

View-model owns the pure function from the roadmap:

```ts
buildRenderModel(
  snapshot: GraphSpace,
  lodResult: LodResult,
  layoutResult: LayoutResult,
  selection: SelectionState,
): RenderModel
```

It performs no I/O, logging, DOM access, or mutation. For equal inputs it emits
byte-identical numeric arrays and identical string tables. Nodes are ordered by
ascending `NodeId`; induced edges retain ADR-0013 order. The result contains no
`Map`, `Set`, functions, class instances, DOM/Pixi values, or references back to
the snapshot. It is structured-cloneable and consists of:

- `nodeIds` and `edgeKeys` lookup tables;
- `Float64Array nodeRects` (`x,y,width,height` lanes) and world `bounds`;
- `Uint16Array nodeColorIds` plus a deterministic kind/color-key table;
- `Uint8Array nodeFlags` (selected/selection-anchor and presentation flags);
- ADR-0020 `labelTable`, `Uint32Array labelRefs`, `Uint8Array labelClasses`, and
  ranking inputs;
- `Uint32Array edgeIndices` (`src,dst` model-index lanes), edge color/weight
  arrays, and packed optional route segments; and
- immutable `RenderDiagnostic[]` plus a deterministic `revision` hash.

Color IDs identify stable visual categories, not literal theme colors; the Phase-
5 renderer maps them through its fixed default palette. Theming remains deferred.
The renderer may down-convert camera-relative geometry to float32 for GPU upload,
but float64 world truth remains in `RenderModel` per ADR-0015.

**Hostile layout defense remains pure.** A missing rectangle or non-finite
`x/y/width/height` becomes zero for that field; a negative size becomes zero.
Each repair appends one located diagnostic `{ code, nodeId, field, received }`,
deduplicated per node/field. Bounds are recomputed from repaired rectangles and
routes. The input `LayoutResult` is never mutated, and `buildRenderModel` never
calls `console`; the Studio/renderer boundary decides how diagnostics are shown.
Thus “clamped + warned” is compatible with a pure builder.

**Permanent dependency direction.** After 5B:

```text
graph-core/types + abstraction ──> view-model <── layout
                                      │
                                      v
                                  renderer (+ pixi leaf)

studio (composition root) ──> store / plugins / abstraction / layout /
                              view-model / renderer
```

`renderer` imports `@meridian/view-model` and its isolated Pixi dependency only;
it may not import graph-core, graph-store, abstraction, layout, React, zustand, or
an adapter. `layout` may not import renderer. Studio is the only composition
root. The direct type-only `view-model → graph-core` edge needed by the roadmap's
literal `GraphSpace`/ID signature is proposed for review below; there is never a
runtime graph-core call from the builder.

**Zustand owns values, never engines.** Studio uses one vanilla zustand store
with React selector bindings. It may hold project/session values: open-source
status, adapter choice, immutable graph version token, current `RenderModel`,
`CameraState`, `SelectionState`, selected-node panel data, diagnostics, and debug
HUD samples. It must not hold a `SceneAdapter`, Pixi object, WebGL context,
worker/proxy, DOM node, `GraphStore` instance, or live plugin capability. Those
long-lived services are owned by an imperative `StudioSession` composition root
outside React state and exposed only through commands/actions.

Selection is identity-based session state. Hover is a renderer-lifetime transient
slice: `{ sceneGeneration, element, screen, world }`, never persisted, placed in
URL/history, or replayed; it clears on pointer leave, model replacement, and scene
destroy. Storing this bounded event value in zustand is transport to the React
consumers named by the roadmap, not promotion to durable/session semantics.

**Canvas island.** The React `CanvasIsland` component renders exactly a container
and `<canvas ref>`. A mount effect creates an imperative `StudioSceneBridge`,
passes it the canvas, and destroys it in cleanup. React may initiate
mount/unmount, but it never calls `scene.render`, `scene.pick`, Pixi, a shader, or
a draw primitive. The bridge:

1. awaits `SceneAdapter.mount` (ADR-0019), guarded by a generation token so late
   readiness after unmount is discarded;
2. subscribes directly to selected zustand values (`renderModel`, `camera`) and
   calls `scene.render` outside React;
3. translates plain renderer hover/select/fault/stats events into store actions;
4. owns `ResizeObserver`, DPR changes, and canvas backing-store resize; and
5. unsubscribes and destroys the scene idempotently.

React/CSS owns the canvas's layout size; the bridge/renderer owns intrinsic pixel
width/height. Camera updates are coalesced to one store publication per animation
frame, and React components subscribe only to fields they display, so pointer pan
does not rerender the shell. The renderer may update its local camera immediately
for the current frame, then publish the same pure `CameraState`; local state is a
cache, never the only copy.

**Pipeline and event direction.** `StudioSession` performs file read/sniff/ingest,
applies adapter output through the one graph-store delta path, resolves LOD,
requests layout, calls `buildRenderModel`, then publishes the value. The scene
never receives or discovers any earlier-stage object. Downstream data is values;
upstream interaction is plain events:

```text
StudioSession → zustand RenderModel/CameraState → StudioSceneBridge → SceneAdapter
StudioSession ← zustand commands/selection    ← StudioSceneBridge ← pick events
React chrome  ← zustand selectors
```

A selected-node panel is populated by `StudioSession` from the snapshot after a
selection action; the renderer supplies only identity and coordinates. React
therefore cannot accidentally make Pixi call the store, and the renderer cannot
accidentally interpret provenance or attributes.

**Mechanical enforcement.** Dependency-cruiser/ESLint and tests assert:

- no `.tsx`/React component imports `pixi.js` or `packages/renderer/src/pixi`;
- no React component contains `.render(` calls on a `SceneAdapter` (the bridge is
  a plain `.ts` module with an explicit allow-list);
- `packages/renderer` has no graph-store/abstraction/layout/React/zustand imports;
- `packages/layout` imports Meridian types only through view-model after 5B;
- Studio store state contains no DOM/Pixi/scene/worker service types; and
- package public-declaration snapshots expose no Pixi or React type through
  view-model/renderer.

## Alternatives considered

- **React-Pixi / declarative scene components.** Rejected: React would own and
  reconcile 10k visual elements, issue effective draw topology changes, and erase
  the replaceable adapter seam.
- **Renderer reads graph-store and resolves what it needs.** Rejected by the
  constitution's presentation waist and Phase-5 architecture gate; it couples
  pixels to mutable semantic state and makes context recovery non-reconstructive.
- **Put the `SceneAdapter` in zustand.** Rejected: it is non-serializable,
  canvas-lifetime infrastructure and would make a GPU resource part of app state.
- **Pass per-frame props through React.** Rejected: camera and hover cadence would
  drive reconciliation. Vanilla-store subscription lets the bridge observe values
  without rendering the shell.
- **Keep Layout-I/O definitions in layout.** Rejected by ADR-0015's accepted,
  time-boxed ruling and §20's permanent `layout → view-model` direction.

## Tradeoffs & consequences

- Buys: an inspectable serializable waist, a shell that cannot draw, a renderer
  that cannot read semantics, strict GPU lifecycle ownership, and closure of the
  Phase-4 dependency waypoint.
- Costs: an imperative bridge next to declarative React, selector/subscription
  discipline, and type relocation/re-exports in 5B.
- `RenderModel` duplicates selected snapshot/layout fields into packed arrays.
  ADR-A8 accepts that copy in exchange for testability, workers, and N-domain ×
  M-renderer composition.
- Diagnostics are data, so callers must surface them; silently dropping a hostile-
  layout warning is an app-shell bug.

## Reasoning

React is well suited to low-frequency application chrome and poorly suited to a
10k-instance draw loop. The smallest honest boundary is a canvas ref plus an
imperative value bridge. Zustand is useful here because vanilla subscriptions can
feed that bridge without React rendering, while React selectors consume the same
selection/panel values. Moving layout contracts into view-model makes the package
graph match the constitution and ensures both layout and renderer agree on one
presentation vocabulary without depending on each other.

## Future implications

P6 navigation adds a controller/choreographer beside `StudioSession`; it publishes
camera/cut transition values through the same bridge rather than entering React's
draw path. P10 projections can replace the scene while preserving Studio state.
P12 collaboration can serialize view/camera/selection values without ever
serializing a GPU object.

## Open questions for review

1. **`view-model → graph-core` type edge.** Recommended: permit a direct
   **type-only** import for `GraphSpace`, `NodeId`, and provenance/attribute value
   types. It is the honest source of the roadmap's `snapshot` signature, creates
   no runtime edge, and the Presentation charter explicitly consumes semantic-
   core types. Alternative: re-export those types from abstraction so §20's
   shorthand “view-model deps: abstraction” is literal, at the cost of turning
   abstraction into a graph-core type facade. The reviewer must choose; no 5B
   dependency rule is changed until this is ruled.
   **Ruling (5A review, 2026-07-11): accepted as recommended** — direct imports
   from graph-core are type-only; view-model makes no graph-core runtime call.
2. **Transient hover transport.** Recommended: allow the generation-scoped,
   non-persisted zustand slice above so React can consume the roadmap's hover
   stream while preserving ARCHITECTURE §10.3 lifecycle. Alternative: keep hover
   wholly inside the renderer and expose no React hover consumer in Phase 5.
   **Ruling (5A review, 2026-07-11): accepted as recommended** — the transient
   slice is allowed and never enters persistence, URL state, or history.
