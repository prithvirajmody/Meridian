# @meridian/plugin-host

## Unreleased — Phase 11 streaming ingest

Additive `PluginHost.ingestStreaming`: parser emissions are forwarded through
a serialized, drainable async queue without host-side document/delta arrays.
It closes and fully drains the sink before resolving, reports partial counts
as values on failure, propagates an optional cancellation signal to long-running
parsers, and makes publication of caller-owned staging explicit. The existing
buffered, atomic `ingest` path is unchanged.

## 0.1.0 — 2026-07-05 (Phase 2)

Initial host: `createPluginHost` with manifest schema-parsing (zod),
apiVersion range check (exact/caret, ADR-0010), activation isolation,
declared-vs-exported capability reconciliation, cross-plugin vocabulary
aggregation with conflict refusal (U8), sniff arbitration (clamping,
throw-scores-zero, tie refusal), and buffered atomic ingest with typed
`HostIssue` failures (ADR-0009).
