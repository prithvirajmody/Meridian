# Meridian Studio

Phase 5's Vite + React application shell. It is the sole browser composition
root for the first-pixels pipeline:

```text
file → plugin sniff/ingest → IR gate → op-based GraphStore → LOD → layout
     → RenderModel → SceneAdapter
```

Run it from the repository root with `pnpm dev`, then use **Open corpus** for
any file under `fixtures/corpora/markdown/`. Add `?debug=1` to expose the
FPS/heap HUD.

The React/canvas boundary follows ADR-0022: React renders chrome and the canvas
element only. `StudioSceneBridge` owns the renderer, camera, resize/input
listeners, and vanilla-Zustand value subscriptions. Zustand contains no engine,
worker, DOM, graph-store, plugin, or GPU service.

Verification:

- `pnpm --filter @meridian/studio test` — store, pipeline, lifecycle, and
  architecture tests.
- `pnpm --filter @meridian/studio test:e2e` — software-Chromium corpus
  screenshots, interaction latency, real context loss, 10k FPS, and heap soak.
- `pnpm goldens:update:ui:docker` — the only supported screenshot-baseline
  update. It runs `pnpm goldens:update:ui` inside the pinned
  `mcr.microsoft.com/playwright:v<@playwright/test version>-noble` image, the
  same image CI's e2e job uses, and copies back only the `*-snapshots`
  directories. Needs Docker.
- `pnpm goldens:check:ui:docker` — the same visual tests against the committed
  goldens, in that image, without updating them.

Screenshot goldens are renders of that image: its Chromium build, fonts, and
fontconfig. On a desktop, DOM text uses the host's fonts, so the visual tests
in a plain `test:e2e` run can differ from the goldens; compare with
`goldens:check:ui:docker` instead. Running `pnpm goldens:update:ui` directly on
a desktop writes host-font renders that CI rejects. When `@playwright/test` is
bumped, bump the container image tag in `.github/workflows/ci.yml` to match
(the docker script refuses to run otherwise) and regenerate.

The heap test runs for five minutes by default. For local harness development,
`MERIDIAN_HEAP_SOAK_MS=10000 pnpm --filter @meridian/studio test:e2e` shortens
that one measurement; CI never overrides the versioned 300,000ms budget.
