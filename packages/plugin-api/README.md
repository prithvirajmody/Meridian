# @meridian/plugin-api

The versioned plugin contract (ROADMAP Phase 2): the *only* Meridian surface
plugins and the host see. Types and capability descriptors — `MeridianPlugin`,
`PluginManifest`, the closed `CAPABILITY_KINDS` enum (ADR-0011), the
`DomainParser` capability with its `SourceDescriptor`/`IngestSink` shapes, the
injected `PluginContext` facades, and `PLUGIN_API_VERSION` (semver policy:
ADR-0010). Everything that crosses this boundary is structured-clone-safe
(ADR-0009) so Phase 12's worker isolation is a host change, not a plugin
change.

**Public API entry point:** `@meridian/plugin-api` (this package's
`src/index.ts`). Runtime surface is deliberately tiny — `PLUGIN_API_VERSION`,
`CAPABILITY_KINDS`, `NAMESPACED_KEY_PATTERN` — and snapshot-tested; the rest
is types, including re-exported wire types (`GraphDocument`, `SemanticCoords`,
`AttrValueType`) from graph-core.

**Forbidden imports:** everything. The single allowed edge, `@meridian/graph-core`,
must stay **type-only** (§20 dependency law; enforced by dependency-cruiser in
CI). No zod, no node builtins, no domain vocabulary — the grep gate keeps
domain words out of this package entirely.

Versioning discipline: semver with declared breaking-change checkpoints at
Phase 7 and Phase 9 (freeze to 1.0); additive-only in between. Every change
lands in `CHANGELOG.md`.
