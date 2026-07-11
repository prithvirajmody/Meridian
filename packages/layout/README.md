# @meridian/layout

The layout engine of the visual track (ROADMAP Phase 4): it turns
`(cut, inducedEdges, sizes, hints)` into **stable world-space positions** as
pure functions, reviewable via SVG snapshots before any GPU code exists.

**Phase 4B slice (this build):**

- `LayoutProvider` — the pluggable engine contract (`compute(input, prev?,
  signal?)`, `capabilities { incremental, compound, deterministic }`), with
  `LayoutInput` / `LayoutResult` / `LayoutHints` and the world-space geometry
  types `Point` / `Size` / `Rect` (ADR-0015: float64, y-down, abstract units,
  min-corner rects; the renderer owns all screen-space transforms).
- `grid` and `tree` — deterministic, main-thread fallback providers.
  Disconnected components are shelf-packed deterministically (descending area,
  ties ascending min `NodeId`, gap `hints.spacing`); zero-size nodes place as
  degenerate point-rects; `bounds` is the tight AABB; empty cut → `{0,0,0,0}`;
  every tie-break is ascending `NodeId` (I6).
- `stabilityScore(prev, current, hints)` — the **pure** ADR-0016 scorer
  (`Λ` = median neighbor-gap with `hints.spacing` → `1` fallbacks,
  `k(x) = clamp(1 − x/4, 0, 1)`, mean over the persistent set, `1` when
  `P = ∅`, plus `{persisted, added, removed}` diagnostics). Mechanisms (elk
  position hints, force warm-start) are 4D/4E.
- `exportSvg` — a DOM-free, byte-deterministic, normalized SVG exporter: the
  golden-review harness (`meridian layout --svg out.svg`).

**Not here (later subphases):** worker host / cancellation / `LayoutCache`
(4C), `elk-layered` (4D), `d3-force` + the ADR-0018 `chooseProvider`
heuristic (4E).

**Dependency law (ADR-0015 ruling):** imports `@meridian/abstraction`
(`Cut`/`InducedEdge`) and `@meridian/graph-core` (id brands) only. `coords.ts`
and `types.ts` have zero intra-layout imports so they lift into
`@meridian/view-model` at 5B, when the transient `layout → abstraction` edge
is retired. The plugin-api `layout-provider` capability is a structural twin,
pinned by the assignability test in `test/layout-twin.test.ts`.
