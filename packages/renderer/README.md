# `@meridian/renderer`

Phase 5's replaceable presentation adapter. Public declarations contain no
Pixi types; the engine is isolated under `src/pixi/`. Pure camera, spatial
index, and culling modules stay independently testable; Phase 5D adds picking
on the same index.

Build the bare WebGL fixture with
`pnpm --filter @meridian/renderer harness:build`, or run it locally with
`pnpm --filter @meridian/renderer dev`.
