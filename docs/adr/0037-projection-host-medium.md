# ADR-0037 — Projections choose their medium behind a capability-scoped host

- **Status:** Accepted
- **Date:** 2026-07-15
- **Phase:** 10 (roadmap)
- **Constitution:** ARCHITECTURE.md §1.3 (Presentation/Interaction), §9.1–§9.4, §14, §20; ADR-A8, ADR-0009, ADR-0019, ADR-0022, ADR-0033
- **Roadmap:** ROADMAP.md Phase 10 §3–§10, §12
- **Related:** ADR-0036 (mode-switch survival)

## Context

Phase 10 must prove that the presentation waist is genuinely neutral: the
existing map is WebGL/Pixi, the outline is virtualized DOM, and matrix/timeline
use canvas-oriented media. At the same time the constitution's exhaustive
dependency law says `projections` depends only on `view-model` and `layout`;
`renderer` depends on `view-model`; and Studio is the composition root.
`projections` therefore cannot import Pixi, `@meridian/renderer`, React,
zustand, `graph-store`, an adapter, or `plugin-api`.

The roadmap's interface sketch also makes `mount` synchronous, while accepted
ADR-0019 proves that the map renderer initializes asynchronously. Finally,
`view-projection` is a declared-but-dormant plugin capability in the frozen
1.0 API. Making it live must remain additive and isolation-shaped without
exposing a DOM node, GPU object, or store through the plugin boundary.

This record fixes package ownership, the projection/host lifecycle, medium
ports, the plugin structural twin, and domain-neutral temporal metadata.

## Decision

### The neutral model belongs in `@meridian/view-model`

`ProjectionModel` is the pure, structured-cloneable value that all projections
consume. It belongs in `@meridian/view-model`, beside `RenderModel`, because it
is the presentation waist rather than a projection implementation. It contains
the visible cut identities, induced edges, labels/kinds/attrs, containment and
level context, domain metadata, canonical selection/focus, and optional layout.
Layout is genuinely optional: outline and matrix must work without manufacturing
positions. When layout exists, the map-facing render value is derived through
the existing byte-deterministic `buildRenderModel` path.

Projection filtering, including the AI-provenance view predicate, occurs before
this model is published. Every projection therefore sees the same semantic
working set; non-map modes cannot accidentally reveal nodes hidden in map mode.

`ProjectionModel` contains data only: no `GraphStore`, snapshot back-reference,
functions, DOM/Pixi values, worker proxy, or mutable application service.

### Interfaces and narrow medium ports live in `@meridian/projections`

The new package owns the internal structural contracts, registry, built-in
projection algorithms, and narrow consumer-owned medium ports:

```ts
interface ViewProjection {
  readonly id: string;
  readonly label: string;
  suitability(model: ProjectionModel): number; // finite, clamped to 0..1
  mount(host: ProjectionHost): Promise<ProjectionInstance>;
}

interface ProjectionInstance {
  render(model: ProjectionModel): void;
  applySelection(selection: SelectionState): void;
  applyFocus(focus: FocusState): void;
  revealFocus(): void;
  captureViewState(): unknown;
  restoreViewState(state: unknown): void;
  destroy(): void;
}
```

Async `mount` is binding: readiness and mount failure are observable, matching
ADR-0019. `destroy` is idempotent. Methods after destroy are located lifecycle
errors. The host wraps every lifecycle call and applies ADR-0036 fallback.

`ProjectionHost` does not hand a projection a concrete container or store.
It provides capability-scoped ports for the media Phase 10 needs: the existing
node-link scene, a virtual DOM-list host, a retained 2D canvas surface, viewport
and clock values, plain input callbacks, diagnostics, and projection-neutral
selection/navigation intent sinks. Data passed through a port is
structured-cloneable; resource objects remain behind the port. This preserves
the roadmap's “host provides container/input/state” intent without leaking
`HTMLElement`, `SceneAdapter`, Pixi, zustand, or `GraphStore`.

`@meridian/projections` imports only `@meridian/view-model` and
`@meridian/layout`. It never imports `abstraction` directly; the types and data
it needs arrive through the view-model waist. Dependency-cruiser makes that
allow-list exhaustive.

### Concrete media and composition stay downstream

`@meridian/renderer` owns the concrete WebGL scene, DOM virtualization host,
2D canvas resource lifecycle, picking, context recovery, and medium statistics.
It remains unaware of graph/store semantics and imports only view-model data.

Studio implements the internal `ProjectionHost` by adapting those renderer
surfaces. It owns projection-instance lifecycle, mode switching, per-View state,
input routing, navigation coupling, diagnostics, and fault fallback. React owns
only the projection host layout box and chrome; it does not issue draw calls or
virtualized-row mutations. This extends ADR-0022's canvas-island rule to a
medium-neutral projection island.

`MapProjection` uses the existing `StudioSceneBridge` behavior through the
node-link port. The Pixi path, camera math, input cadence, and frame probe remain
unchanged during 10B; existing screenshots and FPS/heap/transition tests are the
non-negotiable extraction gate.

### The public plugin capability is an additive structural twin

`@meridian/plugin-api` cannot import the internal projections package, and the
internal package cannot import `plugin-api`. Phase 10 therefore follows the
existing layout-provider precedent: plugin-api declares a structural twin using
plugin-api/core wire types and a capability-scoped host facade; compile-time
assignability and conformance tests pin it to the internal contract.

`PluginExports` gains an optional `viewProjections` collection. `plugin-host`
validates declared/exported ids, rejects duplicates, exposes ordered resolution,
and isolates activation/lifecycle faults. No public declaration contains an
internal `ProjectionModel`, renderer type, DOM type, store type, React/zustand
type, or raw resource handle.

The dormant capability becoming authorable adds public exports and an optional
`PluginExports` field. Under ADR-0033 this is additive but requires a minor
release: `PLUGIN_API_VERSION` becomes **1.1.0**, the api-extractor report is
regenerated with the documented command, the changelog records the addition,
and existing `^1.0.0` manifests remain compatible. The four built-ins use the
same host registry through the structural bridge; Phase 10 ships no additional
third-party projection.

### Temporal suitability is declared, not domain-hard-coded

`DomainMeta` carries optional presentation hints, including temporal start/end
attribute keys and an optional lane attribute. These are plain optional plugin
metadata. The conversation adapter declares its existing `conv:timestamp` key;
the timeline never checks for the word “conversation” or imports an adapter.

The view-model builder normalizes declared ISO-8601 or finite epoch-seconds
values and may roll descendant times into a visible aggregate extent. Missing or
invalid times remain located diagnostics. With no usable temporal extent,
timeline suitability is zero and an explicitly chosen timeline renders the
degraded message required by the roadmap.

## Alternatives considered

- **Let projections import renderer.** Rejected: it violates the exhaustive
  package law and reverses the presentation pipeline.
- **Put `ProjectionModel` in the projections package.** Rejected: the neutral
  value is the shared waist consumed before a metaphor is chosen.
- **Expose a raw DOM element/canvas/context/store in `ProjectionHost`.**
  Rejected: it leaks medium/application ownership, breaks the isolation-shaped
  plugin contract, and makes Phase-12 worker isolation a rewrite.
- **Keep `mount` synchronous and hide readiness.** Rejected by ADR-0019 and by
  the required mount-failure fallback test.
- **Import internal projection types into plugin-api.** Rejected by §20. The
  structural-twin pattern is already established for layout providers.
- **No plugin-api version bump.** Rejected: new author-facing exports are a 1.x
  minor under the accepted freeze policy, even though runtime enum membership
  already exists.
- **Hard-code `conv:timestamp`.** Rejected: presentation packages contain no
  domain vocabulary; temporal semantics are declared metadata.

## Tradeoffs & consequences

Narrow ports and structural twins create adapter and conformance work, and a
projection cannot reach for arbitrary DOM/canvas APIs. In exchange, package
arrows remain enforceable, media are replaceable, plugin inputs stay
isolation-shaped, and map extraction can reuse the exact rendering path.

Plugin API 1.1 is intentional contract growth and pays the api-extractor,
changelog, host-routing, and conformance tax. DOM and canvas hosts become
renderer responsibilities, while projection algorithms remain headless-testable.

## Reasoning

A projection owns the spatial metaphor and chooses the medium it needs; the
host owns resource access, lifecycle, and application state. Capability-scoped
ports are the smallest boundary that allows both claims to be true without
widening package dependencies. Keeping semantic data in a serializable model
and resources behind ports preserves the same value-oriented architecture that
made the original renderer testable.

## Future implications

New media add a host port and renderer implementation without giving projections
store access. Phase 11 can cache/persist `ProjectionModel` and per-View state.
Phase 12 can proxy the public capability facade into an isolated worker because
its calls carry data rather than DOM/GPU/store objects. WebGPU replaces the
node-link port implementation without changing projection or Studio state.

User-composed dashboards, simultaneous projections, 3D, editable projections,
and projection-specific plugins beyond the four built-ins remain explicitly
deferred.

## Phase 10A ruling (2026-07-15)

Accepted as written: package/port ownership and async lifecycle; plugin-api
1.1.0 as the additive public-capability release; and domain-declared temporal
metadata with descendant extent roll-up.
