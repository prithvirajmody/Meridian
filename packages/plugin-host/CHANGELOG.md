# @meridian/plugin-host

## 0.1.0 — 2026-07-05 (Phase 2)

Initial host: `createPluginHost` with manifest schema-parsing (zod),
apiVersion range check (exact/caret, ADR-0010), activation isolation,
declared-vs-exported capability reconciliation, cross-plugin vocabulary
aggregation with conflict refusal (U8), sniff arbitration (clamping,
throw-scores-zero, tie refusal), and buffered atomic ingest with typed
`HostIssue` failures (ADR-0009).
