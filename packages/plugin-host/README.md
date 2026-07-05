# @meridian/plugin-host

The registry side of the plugin boundary (ROADMAP Phase 2): it **registers,
validates, resolves, and isolates errors — nothing else** (the roadmap's
explicit cap). Manifest schema-parsing (zod; an invalid manifest never loads),
apiVersion range checking against `PLUGIN_API_VERSION` (ADR-0010, exact/caret
only), capability routing for the closed enum (ADR-0011), vocabulary
aggregation across plugins (U8; conflicting attr declarations are refused),
sniff arbitration with clamping and tie refusal, and buffered atomic ingest —
a parser that throws mid-stream leaves nothing behind and cannot poison the
host (ADR-0009).

**Public API entry point:** `@meridian/plugin-host` (this package's
`src/index.ts`). Key exports: `createPluginHost`, `PluginHost`
(`register`, `resolve`, `ingest`, `plugins`, `vocabulary`), `parseManifest`,
`satisfies`, `HostIssue`.

**Forbidden imports:** everything except `@meridian/plugin-api` and `zod`
(§20 dependency law; dependency-cruiser-enforced). Notably **not**
graph-core — the host never gates IR or touches a store; the composition
root (CLI now, Studio later) injects graph-core's ID derivation via
`HostOptions.ids` and runs the gate itself. No node builtins: the host is
isomorphic. No domain vocabulary (grep gate).
