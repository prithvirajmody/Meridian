# @meridian/cli

## 0.1.0 — 2026-07-05 (Phases 0–2)

- **Phase 0:** `validate`, `stats`, `inspect`.
- **Phase 1:** `mutate --script/--out/--emit-delta`, `invert`, `watch
  [--apply]`.
- **Phase 2:** `ingest <source> [--adapter] [--out]` (composition root:
  injects graph-core ID derivation into the plugin host, registers built-in
  Tier 0 plugins, runs the IR gate with the registered vocabulary) and
  `plugins list`.
