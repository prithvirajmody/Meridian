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

**Dependency law (ADR-0015/0022):** 5B moved the geometry and Layout-I/O
definitions into `@meridian/view-model`; `coords.ts`/`types.ts` remain
source-compatible type re-exports. Production layout code imports Meridian
contracts only through view-model, retiring the temporary direct abstraction/
graph-core edge. The plugin-api `layout-provider` capability is a structural
twin, pinned by the assignability test in `test/layout-twin.test.ts`.
