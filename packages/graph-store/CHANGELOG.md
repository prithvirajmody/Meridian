# @meridian/graph-store

## Unreleased — Phase 11 streaming staging

Additive `stageDeltaStream`: bounded op batching into a private `GraphStore`,
awaited backend/settle backpressure, progress and peak-buffer statistics, and
failure-as-value outcomes that never expose a partially ingested store.

## 0.1.0 — 2026-07-05 (Phase 1)

Initial store: immutable structurally-shared snapshots (ADR-0006), op-based
deltas as the only write path (ADR-0005, nine-op vocabulary v1, invertible),
atomic transactions, version stamps (ADR-0007), batched async subscriptions
(ADR-0008), incremental adjacency/kind/label indices with fluent queries,
`diffSpaces`. Unchanged in Phase 2 (delta wire consumed by the CLI's ingest
materialization path).
