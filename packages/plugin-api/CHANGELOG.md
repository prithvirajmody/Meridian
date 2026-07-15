# @meridian/plugin-api

Per-package changelogs are mandatory from Phase 2 (ROADMAP §5.4): plugin
authors are downstream consumers even while "plugin authors" means us.
Versioning policy: ADR-0010 (semver; pre-1.0 minors may break, only at
declared checkpoints P7/P9).

## 1.1.0 — Phase 10 (view projections; ADR-0037)

Additive minor under the ADR-0033 freeze policy; existing `^1.0.0` manifests
remain compatible and unchanged plugins need no migration.

- `PluginManifest` gains optional `presentation?: PresentationHints` — plain
  domain-declared presentation metadata. Its first member,
  `TemporalPresentationHints` (`startAttribute` / `endAttribute?` /
  `laneAttribute?`), names the attrs that carry ISO-8601 or epoch-seconds
  times; the view-model normalizes values and located diagnostics replace
  silent coercion. Declared by the conversation adapter
  (`conv:timestamp` / `conv:role`); consumed by the Phase-10 timeline
  projection, which never checks a domain name.
- (Lands with the 10F gate:) the dormant `view-projection` capability becomes
  authorable — `PluginExports.viewProjections` and its structural host-facade
  types.

Report regenerated via the documented `pnpm api:update`.

## 1.0.0 — Phase 9E (the freeze; ADR-0033)

**The contract is frozen.** `PLUGIN_API_VERSION` moves to `1.0.0` and the
exported surface is pinned by the committed api-extractor report
(`etc/plugin-api.api.md`), verified on every test run — accidental drift now
fails CI. Regenerate only via `pnpm api:update` (root) after a reviewed,
changelogged surface change. Evolution is **additive-only until 2.0**: new
exports, new capability kinds, new optional fields; deprecations are marked
in-type and never removed before 2.0.

This release folds in the three post-0.1 additions below (7F
`detail-resolver`, 7G incremental types, 9C `ProposedGroup.kind`) — all
audited into the freeze by `docs/chafe-report-plugin-api-1.0.md`. No symbol
was removed or reshaped; a 0.2-compatible plugin is source-compatible with
1.0.

**Migration (every plugin author):** rebuild against 1.0.0, pass the
conformance kit, set the manifest's `apiVersion` to `'^1.0.0'` — caret-0.x
ranges exclude 1.0 (ADR-0010), so unmigrated manifests are refused at
registration with a typed error. All four first-party adapters and the
toy-adapter exercise migrated this way; none needed any change beyond the
manifest line.

## Unreleased — Phase 9C (conversation enrichment)

Additive, **type-only** — runtime surface unchanged, so no version bump per
ADR-0010. `ProposedGroup` gains an optional `kind?: string`: the namespaced
node kind for the group node a proposal materializes as (e.g. `conv:topic`),
defaulting to `core:cluster` so every existing proposal is byte-identical.
Motivated by ADR-0034: AI-native domains type their enrichment layers with
manifest-declared kinds instead of the generic cluster kind. Flagged for the
Phase-9 chafe report (the P3 rollup seam hard-coded `core:cluster` until a
second domain needed otherwise — the rule-of-three at work).

## Unreleased — Phase 7G (incremental watch mode)

Additive, **type-only** — runtime surface unchanged (`CAPABILITY_KINDS`,
`NAMESPACED_KEY_PATTERN`, `PLUGIN_API_VERSION` still the only runtime exports),
so no version bump per ADR-0010 (the api-surface snapshot is unmoved). New
types: `SourceChange` (`{ path, oldText?, newText? }`, the file-level diff a
watcher feeds in — ROADMAP §7) and `IncrementalAdapter` (`update(change, sink)`,
the watch-mode contract: file change in, a **minimal** op delta out through the
ordinary `IngestSink`, ADR-0005). The incremental *conformance* suite in
`@meridian/conformance-kit` is written against this shape. Flagged for the
Phase-9 chafe report as the second post-P2 contract addition (after 7F's
`detail-resolver`).

## 0.2.0 — Phase 7F (the P7 amendment checkpoint)

**The first post-P2 runtime-surface change** (ADR-0010 §3 schedules a breaking
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
