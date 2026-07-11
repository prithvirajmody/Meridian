# ADR-0019 — Pixi v8 behind `SceneAdapter`, with a closed allowed-API surface

- **Status:** Accepted
- **Date:** 2026-07-11
- **Phase:** 5 (roadmap)
- **Constitution:** ARCHITECTURE.md §1.3 (Presentation), §9.1, §9.3, §17.2, §20; ADR-A8
- **Roadmap:** ROADMAP.md Phase 5 §1, §3, §5–§6, §8–§9, §12

## Context

Phase 5 is the first code that owns pixels and GPU resources. The roadmap fixes
PixiJS v8 as the initial engine, but the constitution fixes a stronger boundary:
the renderer consumes only a serializable view-model, owns no semantic state,
emits input upward, and must be reconstructible after WebGL context loss. A
nominal `SceneAdapter` wrapper is not enough if Pixi types, events, scene objects,
or convenience drawing APIs leak into the package or Studio. This record fixes
the public seam, the deliberately small part of Pixi v8 that may be used, the
instancing shape, and context-loss ownership.

Pixi v8 initializes renderers asynchronously. That makes the roadmap's sketch
`mount(canvas): void` impossible to implement honestly without hiding an
unobservable not-ready interval. The seam below makes readiness explicit.

## Decision

**Public seam.** `@meridian/renderer` exports presentation-neutral structural
types only; no exported declaration names or structurally embeds a Pixi type.
The Phase-5 contract is:

```ts
interface SceneAdapter {
  mount(canvas: HTMLCanvasElement): Promise<void>;
  render(model: RenderModel, camera: CameraState): void;
  pick(screen: ScreenPoint): PickResult | null;
  on(event: 'hover' | 'select' | 'stats' | 'fault', listener: SceneListener): Unsubscribe;
  stats(): Readonly<RendererStats>;
  destroy(): void;
}

function createScene(options?: SceneOptions): SceneAdapter;
```

`mount` resolves only after the renderer and local font assets are ready; calling
`render` or `pick` before it resolves is a located lifecycle error. `mount` is
single-use, `destroy` is idempotent, and every listener/observer/GPU allocation is
released by `destroy`. The Studio canvas island may therefore tolerate React
Strict Mode's mount → cleanup → mount probe without leaking an adapter. The async
return is an intentional refinement of the roadmap interface, not a second API.

**Replaceability boundary.** Direct imports from `pixi.js` are allowed only under
`packages/renderer/src/pixi/`. Pure camera, quadtree, culling, label-tier, event,
and model-diff modules import no Pixi. `apps/studio` imports only the public
`@meridian/renderer` seam. ESLint/dependency-cruiser rules enforce both claims,
and the generated declaration test rejects any public `.d.ts` containing a Pixi
module reference. `pixi.js` is locked by `pnpm-lock.yaml` to one reviewed v8
version; every v8 upgrade reruns screenshots, context-loss, FPS, and the allowed-
API audit. A v9 upgrade requires a superseding ADR.

**Allowed Pixi v8 API list.** Renderer production code may use only the following
public exports and members:

| Purpose | Allowed surface |
|---|---|
| Renderer lifecycle | `WebGLRenderer`; `init`, `render`, `resize`, `destroy`, `canvas`, `resolution` |
| Scene grouping | `Container`; `addChild`, `removeChild`, `removeChildren`, `destroy`, visibility/transform fields |
| Instanced geometry | `Geometry`, `Buffer`, `BufferUsage`, `Mesh`, `Shader`, `UniformGroup`; public buffer update/destroy and `Geometry.instanceCount` APIs |
| Fast labels | `Assets`, `BitmapFont`, `BitmapText` and their public construction/load/update/destroy APIs |
| Shaped Unicode fallback | `Text`, restricted to the bounded fallback in ADR-0020 |

Browser APIs (`requestAnimationFrame`, `ResizeObserver`, pointer/wheel events,
and `webglcontextlost` / `webglcontextrestored`) remain outside Pixi and are owned
by the adapter host. Everything else is denied by default. In particular, Phase
5 does **not** use `Application`, `Ticker`, Pixi's event system, `Graphics`, one
`Sprite` per element, `ParticleContainer`, the Culler plugin, filters, masks,
`HTMLText`, private renderer systems, or a direct WebGL context for ordinary
drawing. Adding an API to the table is an ADR amendment plus an architecture
test change, not an incidental import.

`Application` is excluded because Meridian already owns lifecycle, resize,
render scheduling, and input. `WebGLRenderer` is initialized with the caller's
canvas, `preference: 'webgl'` is achieved by choosing that concrete renderer,
`autoDensity: true`, the current device-pixel ratio (bounded by `SceneOptions`),
and antialiasing off by default. WebGPU is intentionally deferred by the roadmap;
the adapter seam, not a runtime flag, is the future migration point.

**Scene shape and draw calls.** A node is never a Pixi display object. Nodes are
ordered into deterministic world-spatial batches (quadtree/Morton order, small
siblings merged) of at most 512 instances. Each submitted batch is one instanced
quad `Geometry`: one static unit quad plus per-instance
position/size/color/flags buffers, with `Geometry.instanceCount` equal to that
batch's visible count. Straight edges (and each routed polyline segment) use the
same bounded spatial batching in line meshes. The overview ceiling for 10k nodes
is therefore about 20 node-mesh submissions rather than 10k objects, while a
zoomed viewport submits only intersecting batches so the roadmap's “draw calls
drop as you zoom in” claim is directly assertable. Exact per-instance culling
inside boundary batches prevents large loose batches from drawing offscreen
nodes. Labels are the only per-label scene objects, bounded by ADR-0020. Camera
values are shader/uniform inputs or container transforms, never baked back into
the `RenderModel`. Selection and hover change instance flags, not scene topology.

The adapter schedules at most one animation frame when model, camera, hover,
viewport, or font state is dirty. Continuous pointer pan/zoom keeps that loop
dirty; an idle scene sleeps. `RendererStats` reports at least frame time,
Meridian-owned mesh/label-batch submissions (`drawCalls`), model/visible/culled
node counts, edge count, live label count, context-loss count, and buffer-upload
bytes. Because Meridian constructs every submitted batch, this counter needs no
private Pixi instrumentation. The culling and FPS acceptance tests assert through
these public counters rather than private Pixi internals.

**Context loss.** The adapter listens on its canvas, calls `preventDefault()` on
`webglcontextlost`, stops submitting frames, emits one typed `fault` event, and
retains the latest immutable `(RenderModel, CameraState)` plus the CPU-side typed
arrays needed to reconstruct buffers. Pixi's public renderer restores its own
context; on `webglcontextrestored`, Meridian destroys and recreates its
`Geometry`/`Buffer`/`Shader`/`Mesh` objects from those retained values, reapplies
the viewport, and renders one recovery frame. No semantic pipeline rerun and no
store read is permitted. Repeated loss is reported for the later P9 degradation
ladder; Phase 5 must still recover the tested single loss automatically.

Tests induce loss through the standard `WEBGL_lose_context` browser extension
when available. Production code never calls Pixi's private/protected context
systems and never assumes that private GPU handles survive restoration.

## Alternatives considered

- **Let Pixi types be the renderer API.** Rejected: Studio and future renderers
  would compile against Pixi, making `SceneAdapter` ceremonial and violating the
  serializable view-model waist.
- **Use `Application`, `Ticker`, Pixi events, and the Culler plugin.** Rejected:
  those convenience layers take ownership of lifecycle, frame scheduling,
  interaction, and culling that Meridian must measure and test directly.
- **One `Graphics`/`Sprite` per node or edge.** Rejected: 10k display objects are
  the exact CPU/draw-call cliff this phase exists to retire; instanced/batched
  typed buffers match `RenderModel` directly.
- **Raw WebGL renderer with no Pixi.** Rejected for v1: it duplicates resource,
  shader, text, and context-lifecycle infrastructure. The narrow API list keeps
  the dependency replaceable without rebuilding that infrastructure now.
- **WebGPU now.** Rejected by Phase 5's explicit deferral and its less stable
  software-rendering CI story. The public seam leaves it additive later.

## Tradeoffs & consequences

- Buys: a mechanically honest replaceability seam, bounded upgrade surface,
  predictable draw-call topology, independently testable pure machinery, and
  reconstruction from values after context loss.
- Costs: Meridian owns render scheduling, pointer normalization, resize, culling,
  and resource rebuilds instead of delegating them to Pixi plugins; custom
  instanced shaders are more work than `Graphics`.
- The CPU copy of active geometry is intentional memory duplication. It is the
  recovery source and prevents a context loss from forcing a graph/layout rerun.
- `SceneAdapter.mount` being asynchronous flows into the Studio bridge: the
  bridge buffers only the latest pending render and discards it if unmounted
  before readiness.

## Reasoning

The constitution's waist is a value (`RenderModel`), not a scene graph. Keeping
Pixi in one leaf directory and allowing only the primitives needed for two
batched meshes and bounded text makes that waist observable in imports, public
types, and draw-call stats. Manual lifecycle is justified because the hard Phase
5 claims—culling, frame time, context recovery, and no React draw calls—are
claims Meridian must measure rather than infer from a framework plugin.

## Future implications

A WebGPU or reduced DOM/canvas fallback implements the same `SceneAdapter`; it
does not change Studio or view-model. P6 animation retargeting updates camera and
instance buffers through the same seam. P10 projections may choose another
medium, but the node-link Pixi adapter remains isolated here. A Pixi API not on
the table is unavailable until this ADR is amended.

## Open questions for review

1. **Async `mount`.** Accept the `Promise<void>` refinement required by Pixi v8,
   or preserve the roadmap's literal `void` signature and make `createScene`
   itself async/fully mounted. The recommended contract above keeps construction
   side-effect-free and puts readiness on the operation that actually mounts.
   **Ruling (5A review, 2026-07-11): accepted as recommended** — `mount` returns
   `Promise<void>`; construction stays side-effect-free.
