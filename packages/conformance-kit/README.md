# @meridian/conformance-kit

Executable law for plugin capabilities (ROADMAP Phase 2; ARCHITECTURE.md
§7.4). `describeParserConformance({ plugin, corpus })` is a Vitest suite
factory written against the **contract**, not any adapter: manifest/exports
coherence, sniff purity and range, IR validity of every emission at the gate
(decode + the plugin's own declared vocabulary, U8), byte-for-byte
determinism of the skeleton pass (which pins identity stability, U4),
AI-freeness of skeleton output, and crash containment on `reject/` corpus
entries. Every adapter — first- or third-party — must pass it.

**Public API entry point:** `@meridian/conformance-kit` (this package's
`src/index.ts`). Key exports: `describeParserConformance`, `loadCorpusDir`
(sorted walk, NUL-byte binary detection, `reject/` convention — media types
are supplied by the caller, never known to the kit), `idFacade` (graph-core's
deterministic ID derivation shaped as the `PluginContext` facade),
`vocabularyOf`.

**Forbidden imports:** everything except `@meridian/plugin-api`,
`@meridian/graph-core`, and vitest (§20 dependency law;
dependency-cruiser-enforced). It deliberately does not use plugin-host: it
drives parsers through its own buffered sink, exactly the way a compliant
host does. Node builtins are allowed (it is a test harness) but confined to
`corpus.ts`. No domain vocabulary (grep gate).
