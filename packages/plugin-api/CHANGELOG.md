# @meridian/plugin-api

Per-package changelogs are mandatory from Phase 2 (ROADMAP §5.4): plugin
authors are downstream consumers even while "plugin authors" means us.
Versioning policy: ADR-0010 (semver; pre-1.0 minors may break, only at
declared checkpoints P7/P9).

## 0.2.0 — Phase 7F (the P7 amendment checkpoint)

**The first post-2.0 runtime-surface change** (ADR-0010 §3 schedules a breaking
window at Phase 7; this one is only *additive*, so a **minor** bump, not a
break). Flagged here and in `capabilities.ts` for the Phase-9 chafe report
(SUBPHASES §7F / §9E).

Runtime surface: `CAPABILITY_KINDS` gains `detail-resolver` (sixth kind,
appended — ADR-0011/§14.1) and `PLUGIN_API_VERSION` moves `0.1.0` → `0.2.0`.
New types (the `detail-resolver` contract shape, ADR-0027): `DetailResolver`
(`canResolve`/`resolve`), `DetailNode` (the wire node a resolver is handed —
a `GraphDocument` node), `DetailGraphRef`, `DetailContext` (carries the
ADR-mandated `AbortSignal`, mirroring `AbstractionContext`); the
`PluginExports.detailResolvers` export seam (unrouted by the host — consumed by
P6 navigation / P11 persistence; the code adapter's resolver is exercised
directly in 7F). A resolver materializes deep detail on drill-in and emits it
through the existing `IngestSink` as op-based deltas (ADR-0005, no second write
path). Existing `^0.1.0` consumers still satisfy the range under the 0.x caret
convention, so no adapter manifest needs editing.

## Unreleased (Phase 3B)

Additive, type-only — runtime surface unchanged (no version bump required
under ADR-0010; the `abstraction-provider` enum entry already shipped in
0.1.0). New types for the Phase 3 abstraction seam:
`AbstractionProvider`/`AbstractionProposal`/`AbstractionContext`/
`ProposedGroup` (the `abstraction-provider` capability's contract shape, §5.2
— deterministic impls land in 3D, AI in P8); `PluginExports.abstractionProviders`
(the export seam, unrouted by the host until 3D); `LevelChainSpec`/`LevelSpec`
plus the optional `PluginManifest.levelChain` field, letting a parser name its
domain's abstraction levels without touching its mapping code (§7.2.1). A
domain that declares no chain gets a default containment-depth chain from
`@meridian/abstraction`.

## 0.1.0 — 2026-07-05 (Phase 2)

Initial contract. Runtime surface: `PLUGIN_API_VERSION`, `CAPABILITY_KINDS`
(`domain-parser` implemented; `abstraction-provider`, `layout-provider`,
`view-projection`, `ai-provider` declared-but-dormant, ADR-0011),
`NAMESPACED_KEY_PATTERN`. Types: `MeridianPlugin`/`PluginExports`,
`PluginManifest` (capabilities, `kinds`, `attrSchemas` — U8 vocabulary),
`DomainParser`, `SourceDescriptor`, `IngestSink` (documents + delta wire,
streaming from day one), `IngestReport`, `PluginContext` (`ids`, `log`).
