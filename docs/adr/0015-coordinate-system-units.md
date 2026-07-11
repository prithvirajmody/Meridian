# ADR-0015 — Coordinate system & units: world-space float64, y-down, renderer owns pixels

- **Status:** Proposed
- **Date:** 2026-07-06
- **Phase:** 4 (roadmap)
- **Constitution:** ARCHITECTURE.md §20 (dependency law), §5.1 (cut → view-model), §5.6, §3.2 (I6); ADR-A1
- **Roadmap:** ROADMAP.md Phase 4 §5, §7, §8 (ADR-0015), §12

## Context

Layout turns `(cut, inducedEdges)` into 2D positions (§5.1: "everything the user
sees is a rendering of a Cut plus its induced edges"). The roadmap fixes the
output shape — `LayoutResult { positions: Map<NodeId, Rect>; edgeRoutes?; bounds:
Rect; stability }` — and mandates "world-space coordinates: float64, y-down,
arbitrary units; the renderer owns all screen-space transforms; layout never sees
pixels" (§7, §8). This record fixes the concrete geometry types (`Point`, `Size`,
`Rect`), the semantics of `bounds`, and the world-space treatment of the two
degenerate inputs the verification table names (zero-size nodes; disconnected
components). It also resolves the dependency-law question of **which package owns
these types in Phase 4**, because ARCHITECTURE §20 and roadmap §12 point at
different homes and the ARCHITECTURE-named home does not yet exist — see *Open
questions*.

## Decision

**Coordinate space.** One coordinate system crosses the layout boundary: **world
space**. It is a right-handed-on-screen plane with **y increasing downward**
(the screen/DOM convention, so the renderer's world→screen map is a pure
scale+translate with no axis flip), coordinates are IEEE **float64**, and units
are **abstract world units** with no physical meaning — never pixels, points, ems,
or device units. The renderer (P5) owns the sole world→screen transform (camera
scale + translation); layout emits nothing pixel-aware. There is no mandated
origin: a provider may place content anywhere in the plane, and consumers read
`bounds` rather than assuming content starts at `(0,0)`.

**Geometry types.** Three plain, immutable, presentation-neutral records:

```ts
interface Point { readonly x: number; readonly y: number; }              // world units, y-down
interface Size  { readonly width: number; readonly height: number; }     // world units, both ≥ 0
interface Rect  { readonly x: number; readonly y: number;                 // min corner (top-left, y-down)
                  readonly width: number; readonly height: number; }      // both ≥ 0
```

- `Rect.(x, y)` is the **minimum corner** — because y grows downward, that is the
  visual top-left. A node's placed box spans `[x, x+width] × [y, y+height]`; its
  center is `(x + width/2, y + height/2)`.
- Every emitted coordinate is **finite** (no `NaN`, no `±Infinity`): a well-formed
  provider output contains only finite float64. Defensive clamping of hostile
  values is the renderer's job (roadmap 5B, "NaN-position clamping"), not layout's
  — but a provider that emits a non-finite value is producing a bug, not a
  supported degenerate case.

**`LayoutResult.positions`.** `ReadonlyMap<NodeId, Rect>` over exactly
`cut.members` — one placed box per visible node, its `Size` taken from
`LayoutInput.sizes` (providers place the box; they do not invent sizes).

**`LayoutInput.compound` (folded back from 4D).** `LayoutInput` gains an optional
`compound?: CompoundNesting` — the graph-containment grouping that compound-aware
providers (elk-layered) turn into nested container nodes. Flat providers ignore
it. Synthetic container boxes get layout-computed sizes but are **not** returned
in `positions` (only members are, at their input `Size`) — containers are
layout-internal scaffolding, so "providers place the box; they do not invent
sizes" continues to hold for every emitted position.

**`bounds` semantics.** `bounds` is the smallest axis-aligned `Rect` that
**encloses every node position `Rect` and every `edgeRoutes` point** — the tight
world-space AABB of everything the layout emitted, so the renderer can frame the
whole result with one rect. Straight (unrouted) edges connect points already
inside node boxes and never enlarge `bounds`; orthogonal/routed polylines may bow
outside node boxes and are therefore included. For an **empty cut**
(`members.length === 0`) `bounds = { x: 0, y: 0, width: 0, height: 0 }`.

**Zero-size nodes.** A node whose `Size` is `{ width: 0, height: 0 }` (verification
"zero-size nodes"; e.g. a marker with no measured content) is placed as a
**degenerate point-rect**: `positions.get(n) = { x, y, width: 0, height: 0 }`. It
participates in layout as its center point, contributes that point to `bounds`,
and providers must treat size defensively (no division by width/height; no
`log(0)`). Giving a zero-size node a *visual* minimum footprint is a **renderer**
decision (P5), never layout's — layout reports the truth, that the node occupies
no world area.

**Disconnected components.** The induced graph over a cut is frequently
disconnected (a forest of unrelated roots; isolated nodes with no induced edges).
A provider lays out each connected component in its own local frame, then **packs
the component AABBs into the shared world plane deterministically**: components are
ordered by descending area, ties broken by **ascending minimum member `NodeId`**
(I6), and placed by a deterministic shelf/row packing with gap `LayoutHints.spacing`
between component AABBs, so components never overlap and the same input yields
byte-identical placement. A single isolated node is a component of one and is
packed identically. `bounds` then encloses all packed components.

**Determinism (I6).** For fixed `(cut, inducedEdges, sizes, hints)` a provider's
geometry is a deterministic function — same input, byte-identical `positions`,
`edgeRoutes`, `bounds`. Force layout achieves this via its seeded PRNG
(ADR-0018/roadmap §9b); every tie-break above resolves by ascending `NodeId`.

**Dependency home for the geometry + Layout-I/O types** *(ruled at 4A review,
2026-07-06 — see Open questions Q1 for the full analysis)*. **§20 is the
authoritative final topology; roadmap §12 is the Phase-4 waypoint.** In Phase 4,
`@meridian/layout` **defines** `Point`/`Size`/`Rect` (in `coords.ts`) and
`LayoutInput`/`LayoutResult`/`LayoutHints` (in `types.ts`), importing
`Cut`/`InducedEdge` from `@meridian/abstraction` and the id brands from
`@meridian/graph-core`. These type modules are authored with **zero
intra-`layout` imports** so they lift cleanly. The transient
`layout → abstraction` edge is a **documented, time-boxed waypoint**: the
**5A ADR beat and subphase 5B are obligated to retire it** — the type
definitions move into (or are re-exported through) `view-model` and `layout`'s
dependency is repointed from `abstraction` to `view-model`, restoring literal
§20 compliance as a type-only relocation with no behavior change. **This
obligation must appear in the 5A kickoff prompt.** Until then the depcruise
config permits `layout → abstraction` explicitly; that permission is removed
at 5B.

## Alternatives considered

- **y-up (math convention).** Rejected: forces an axis flip in the renderer's
  world→screen map for no gain; layout has no geometric reason to prefer y-up and
  the whole downstream stack (DOM, canvas, pixi) is y-down.
- **`positions` as `Point` (centers) instead of `Rect`.** Rejected: the roadmap
  fixes `Map<NodeId, Rect>`, and compound/edge routing need the box, not just the
  center. `Rect` subsumes `Point` (center is derived).
- **Mandating origin at `(0,0)` (top-left of content).** Rejected: it would force
  a normalization pass and, worse, fight the stability contract (ADR-0016), where
  a node's *absolute* world coordinate must persist across re-layouts. Consumers
  read `bounds` instead.
- **Integer / fixed-point world units.** Rejected: float64 is the substrate every
  engine (elkjs, d3-force) already computes in; quantization buys nothing and
  costs precision on large graphs.
- **Owning geometry types in `graph-core`.** Rejected: `graph-core` is the pure
  USG model that "depends on nothing" and forbids presentation concepts (§20,
  §3.3). World-space presentation geometry there is textbook waist erosion.

## Tradeoffs & consequences

- Buys: a single, testable world space; a renderer transform that is pure
  scale+translate; degenerate inputs (zero-size, disconnected) have *defined*
  world positions, so the failure-case tests assert behavior rather than absence
  of a crash.
- Costs: consumers must always consult `bounds` (no free "content starts at
  origin" assumption); the deterministic component packing is extra provider work
  that a connected graph never needs.
- `edgeRoutes` is `ReadonlyMap<string, Point[]>` keyed by the induced edge's
  `"src→dst→kind"` identity (matching ADR-0013's ordering); absent/empty means the
  renderer draws straight center-to-center lines (roadmap §9c: v1 straight lines,
  splines deferred).

## Reasoning

Pixels are a device- and camera-dependent quantity; putting them behind the layout
boundary would couple the pure, worker-hosted layout to a renderer and a DPI
(§1.4, §5.1). World-space float64 with an abstract unit is the only choice that
keeps layout a pure function of graph geometry, testable via SVG snapshots with no
GPU (roadmap §11). y-down and min-corner `Rect` are chosen so the renderer's map is
trivial and the SVG exporter's coordinate math is identity-plus-offset. Defined
positions for the two degenerate inputs turn the roadmap's failure-case row into
concrete assertions.

## Future implications

These types are consumed unchanged by view-model (P5), the SVG exporter (4B), and
the renderer (P5). Worker serialization (ADR-0017) encodes a `Rect` as four
consecutive float64 lanes precisely because the type is four finite numbers.
Draggable manual layout (deferred, P10+) will persist world-space `Rect`s, so
fixing the space now is what makes that additive later. The contract locks us into
2D-planar geometry — an acknowledged limit (§21, "no 3D/VR metaphor").

## Open questions for review

1. **Dependency-law home for the geometry + Layout-I/O types (§20 vs §12).**
   ARCHITECTURE §20's dependency law lists `layout` deps as **"view-model types"**
   (and `view-model` deps as `abstraction`), i.e. in the *final* topology
   `Point`/`Size`/`Rect`/`LayoutInput`/`LayoutResult` live in **view-model** and
   `layout` imports `Cut`/`InducedEdge` re-exported *through* view-model — a direct
   `layout → abstraction` edge is not in §20's exhaustive list, so it is forbidden
   in the end state. But roadmap Phase 4 §12 says `layout` "imports
   `abstraction`/`graph-core` types only," and **view-model does not exist until
   Phase 5B** (the anti-scope for 4A forbids creating it). The two cannot both be
   satisfied literally in Phase 4. **Proposed reading (recommended):** §20
   describes the authoritative *final* topology; roadmap §12 is the Phase-4
   *waypoint*. In Phase 4, `@meridian/layout` **defines** `Point`/`Size`/`Rect`
   (in a `coords.ts`) and `LayoutInput`/`LayoutResult`/`LayoutHints` (in a
   `types.ts`), importing `Cut`/`InducedEdge` from `@meridian/abstraction` and the
   id brands from `@meridian/graph-core` — the only packages that exist. These type
   modules are authored with **zero intra-`layout` imports** so they lift cleanly.
   At **5B**, view-model is created; the geometry + Layout-I/O type *definitions*
   **move into view-model** (or view-model re-exports them), and `layout`'s
   dependency is **repointed from `abstraction` to `view-model`** — restoring
   literal §20 compliance. depcruise then gains the `layout → view-model` edge and
   loses `layout → abstraction`; because it is a type-only relocation, no runtime
   behavior changes and the golden SVGs are untouched. This honors "ARCHITECTURE
   wins conflicts" by treating §20 as the invariant end state and §12 as the
   sequencing constraint that gets there without inventing view-model early.
   **Reviewer decides:** (a) accept the transient `layout → abstraction` edge as a
   documented, time-boxed waypoint that the P5 ADR/subphase must retire; or (b)
   require the geometry types' *permanent* home to be a dedicated future geometry
   module rather than view-model; or (c) direct that `Cut`/`InducedEdge` be
   consumed only via a view-model re-export from 5B onward with layout never
   importing `abstraction` structurally (types-only import at the `.d.ts` level).
   Whichever is chosen must be reflected in the 5A ADR beat and the depcruise
   config; this note is the flag.
   **Ruling (4A review, 2026-07-06): option (a) accepted** — the transient
   `layout → abstraction` edge is a documented, time-boxed waypoint; §20 remains
   the authoritative final topology; 5A/5B are obligated to retire the edge by
   repointing `layout` to `view-model`. Recorded in the Decision section above.
2. **`bounds` inclusion of routed edges.** Proposed: `bounds` encloses node rects
   *and* `edgeRoutes` points. Alternative: node rects only (simpler, but a routed
   polyline could then extend outside `bounds`, surprising the renderer's framing).
   Recommended as specified.
   **Ruling (4A review, 2026-07-06): accepted as specified.**
3. **`edgeRoutes` key.** Proposed `"src→dst→kind"` string matching ADR-0013's
   induced-edge identity. Confirm, or prefer an opaque edge index into a parallel
   array (cheaper over the worker boundary — see ADR-0017).
   **Ruling (4A review, 2026-07-06): accepted as specified** — string key
   `"src→dst→kind"` at the API level; CSR index encoding on the wire per
   ADR-0017.
