# @meridian/plugin-api

Per-package changelogs are mandatory from Phase 2 (ROADMAP §5.4): plugin
authors are downstream consumers even while "plugin authors" means us.
Versioning policy: ADR-0010 (semver; pre-1.0 minors may break, only at
declared checkpoints P7/P9).

## 0.1.0 — 2026-07-05 (Phase 2)

Initial contract. Runtime surface: `PLUGIN_API_VERSION`, `CAPABILITY_KINDS`
(`domain-parser` implemented; `abstraction-provider`, `layout-provider`,
`view-projection`, `ai-provider` declared-but-dormant, ADR-0011),
`NAMESPACED_KEY_PATTERN`. Types: `MeridianPlugin`/`PluginExports`,
`PluginManifest` (capabilities, `kinds`, `attrSchemas` — U8 vocabulary),
`DomainParser`, `SourceDescriptor`, `IngestSink` (documents + delta wire,
streaming from day one), `IngestReport`, `PluginContext` (`ids`, `log`).
