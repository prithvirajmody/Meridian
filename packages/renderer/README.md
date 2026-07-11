# `@meridian/renderer`

Phase 5's replaceable presentation adapter. Public declarations contain no
Pixi types; the engine is isolated under `src/pixi/`. Pure camera, spatial
index, culling, zoom-tiered label planning, and CPU hit testing stay
independently testable. The worker-built packed quadtree serves both culling
and synchronous picking. Pixi's leaf renders bounded MSDF `BitmapText` labels
plus the ADR-0020 shaped-Unicode fallback.

Build the bare WebGL fixture with
`pnpm --filter @meridian/renderer harness:build`, or run it locally with
`pnpm --filter @meridian/renderer dev`. After building, run
`node packages/renderer/tools/fps-probe.mjs` from the repository root for the
10k labelled SwiftShader probe; it exits nonzero when draw or RAF p95 exceeds
18ms.

The checked-in DejaVu MSDF atlas and license live under `assets/fonts/`.
Regenerate it only through `pnpm --filter @meridian/renderer font:regen`.
