# ADR-0021 — Picking: worker-built world-space quadtree, synchronous CPU hit-test

- **Status:** Accepted
- **Date:** 2026-07-11
- **Phase:** 5 (roadmap)
- **Constitution:** ARCHITECTURE.md §1.3 (Presentation), §9.1, §9.3, §10.3, §17.2, §20; ADR-A8
- **Roadmap:** ROADMAP.md Phase 5 §1, §3, §5–§9, §11–§12

## Context

The renderer must map a screen point to a node or induced edge, support hover and
selection in under 16ms, remain correct at node/edge boundaries and high DPI,
and use the same spatial machinery to prove viewport culling is active. The
roadmap asks this ADR to choose between a GPU pick buffer and quadtree hit-test
using measured numbers, with quadtree favored for simplicity.

On 2026-07-11 a disposable Node benchmark (not repository implementation code)
measured a simple capacity-16 AABB quadtree over 10,000 deterministic rectangles
on Node 24.15.0 / Linux x64 / Intel i5-12450H. Across 30 rebuilds and 20,000 point
queries per fixture:

| Fixture | Rebuild median / p95 | Query p50 / p95 / p99 | Linear-scan p95 |
|---|---:|---:|---:|
| Uniform | 4.36 / 10.82ms | 0.0048 / 0.0093 / 0.0250ms | 0.188ms |
| 20 clusters | 4.50 / 7.11ms | 0.0048 / 0.0083 / 0.0146ms | 0.084ms |

The query is over three orders of magnitude below the 16ms interaction budget;
the rebuild can exceed the 4ms main-thread budget and therefore belongs in a
worker. Since the CPU path already clears the target by a wide margin, a GPU
baseline would require building an otherwise unnecessary color pass plus a
synchronous readback path. The decision is to take the measured sufficient path,
not add a second renderer to prove it is also fast.

## Decision

**One world-space spatial index.** Phase 5 uses a deterministic loose quadtree
over the immutable `RenderModel` geometry. It indexes:

- each node's world-space AABB with its model index; and
- each straight/routed edge segment's AABB with its edge index and segment
  endpoints.

The same node index answers viewport intersection for culling and point/region
queries for picking. Edges are culled/picked through a sibling segment tree with
the same packed representation; an edge is never inserted once per pixel and no
screen-space index is rebuilt on camera movement.

**Build off-main, query on-main.** Model/layout changes send transferable typed
arrays to a dedicated index worker, following ADR-0017's request-id, cancellation,
and stale-result conventions. The worker returns a packed, read-only tree:
Float64 node bounds, Int32 child/item offsets, and Uint32 model indices. A newer
model cancels or supersedes an older build. The host keeps using the prior index
only while its `modelRevision` still matches; it never returns an identity from a
stale revision. Picking is temporarily unavailable (typed `not-ready`, surfaced
as `null` by the simple public method) during the first build, but drawing is not
blocked.

Tree construction and traversal are pure modules with no worker, DOM, or Pixi
imports, so unit/property tests exercise them synchronously. Capacity is 16,
maximum depth is 12, children split in fixed NW/NE/SW/SE order, and items crossing
a child boundary remain in the parent. Items and query results tie-break by model
index; build order cannot alter the packed bytes.

**Coordinate normalization.** Pointer input is converted from `clientX/Y` to
canvas-local **CSS pixels** using `getBoundingClientRect()`, then through the pure
inverse camera transform to world space. `devicePixelRatio` affects only the
canvas backing store and never enters picking tolerance. Resize and browser zoom
therefore change the transform, not the index or the meaning of a hit.

**Node hit rule.** The renderer first queries a square around the world point
whose half-width is `2 CSS px / camera.scale`, then applies exact screen-space
containment against the same visual rectangle it draws. Non-degenerate node
bounds are closed on all four sides. A zero-size layout node is drawn and picked
as a 6×6 CSS-px centered marker (the renderer-side minimum footprint permitted by
ADR-0015). If rectangles overlap or share a boundary, the winner is the topmost
drawn node: hover layer, then selected layer, then greater model index (nodes are
otherwise drawn in ascending model-index order). Drawing and picking use the same
`visualLayer` comparator.

**Edge hit rule.** If no node wins, candidate edge segments are tested by exact
point-to-segment screen distance with a **4 CSS px inclusive** tolerance. A routed
edge tests each of its polyline segments; a straight edge uses the centers of its
endpoint rectangles. The winner is minimum distance, then greater rendered edge
index. Nodes always beat edges near endpoints. The public result includes the
stable induced-edge key, not the transient segment number:

```ts
type PickResult =
  | { kind: 'node'; nodeId: NodeId; screen: ScreenPoint; world: WorldPoint }
  | { kind: 'edge'; edgeKey: string; screen: ScreenPoint; world: WorldPoint };
```

**Event cadence.** Pointer move is coalesced to at most one hit-test and one
`hover` emission per animation frame; unchanged results emit nothing. Pointer
down/up selection performs an immediate hit-test against the same index. A
pointer leaving the canvas clears hover. The measured Playwright round-trip is
event timestamp → zustand selection visible in the side panel and must remain
under 16ms; quadtree query time is reported separately in renderer stats.

**Culling contract.** The visible world rectangle is the inverse-transformed
viewport expanded by a 64-CSS-px prefetch margin. The quadtree returns candidate
nodes and deterministic spatial-batch ids (ADR-0019); exact AABB intersection
removes loose-tree false positives and compacts only the boundary batches. Edges
render when their segment intersects that expanded rectangle. Stats expose total,
candidate, visible, culled, and submitted-batch/draw-call counts. The 5C culling
test must show both visible instances and submitted draw calls falling as the
camera zooms into a strict subregion; merely setting Pixi `visible` flags on 10k
objects would not satisfy this record.

## Alternatives considered

- **GPU color pick buffer + `readPixels`.** Rejected for v1: it adds a render
  pass, ID-color encoding, framebuffer lifecycle/context-loss work, and a
  synchronous CPU/GPU readback. The measured CPU query is already far inside the
  end-to-end budget and also supplies culling, which a pick buffer does not.
- **Linear CPU scan.** Rejected despite acceptable synthetic single-query p95:
  hover performs repeated queries, edge-segment counts can greatly exceed node
  counts, and linear scan provides no culling. Quadtree cost is justified once.
- **Use Pixi's event system/hit testing.** Rejected by ADR-0019: it requires one
  display object per hit target and makes result order/cost depend on Pixi scene
  internals.
- **Rebuild a screen-space index on every camera change.** Rejected: pan/zoom is
  the hot path. World geometry is stable across camera changes; tolerances are
  converted at query time.
- **Build the tree synchronously on the UI thread.** Rejected by the measured
  7–11ms p95 rebuild, which exceeds ADR-0017's 4ms main-thread ceiling.

## Tradeoffs & consequences

- Buys: one deterministic structure for both picking and culling, sub-millisecond
  synchronous queries, no GPU stalls, DPI-invariant behavior, and headless tests.
- Costs: a worker build/transfer and packed-tree implementation; picking is not
  ready for a short interval after the first model; routed edges add segment
  entries.
- Memory is O(nodes + route segments). The worker input/output buffers are tied
  to a model revision and released when the replacement index becomes active.
- Quadtree boundaries and visual z-order become public tested behavior rather
  than an accidental property of Pixi traversal.

## Reasoning

Picking must answer synchronously at pointer-event speed, whereas index building
is occasional and may run off-main. The measurements show exactly that split:
queries are negligible and rebuilds are not. A world-space quadtree composes with
the pure camera and typed `RenderModel`, does useful culling work in every frame,
and has no dependence on a GPU context that can be lost.

## Future implications

P6 anchor selection and transition hit-testing reuse the same world/screen math;
while nodes animate, their transient screen geometry may use a small frame-local
overlay index without changing the stable model index. P10 non-node-link
projections can provide another `SceneAdapter` picking implementation. A GPU
buffer remains an internal replacement if future measured density makes CPU
queries miss budget; `PickResult` does not change.

## Open questions for review

1. **First-index not-ready behavior.** Recommended: render immediately and return
   no picks until the worker publishes the matching index. Alternative: block the
   first frame on index readiness, making the canvas fully interactive at first
   paint but coupling first-render latency to the worker.
   **Ruling (5A review, 2026-07-11): accepted as recommended** — first paint does
   not wait for the index; picking returns no result until the matching revision
   arrives.
