# @meridian/graph-store

The mutation layer of the semantic core (ROADMAP Phase 1): an in-memory
`GraphStore` holding immutable, structurally-shared `GraphSpace` snapshots,
mutated **exclusively** through op-based `GraphDelta`s applied in atomic
transactions — the one write path (ADR-0005, constitution P2). Provides
version stamps (ADR-0007), batched async change subscriptions (ADR-0008),
incrementally-maintained indices with a fluent query API, delta
invert/compose, a pure `applyDelta`, and `diffSpaces` for producers that
cannot emit ops natively.

**Public API entry point:** `@meridian/graph-store` (this package's
`src/index.ts`). Key exports: `createStore`, `applyDelta`, `invertDelta`,
`composeDeltas`, `diffSpaces`, `decodeDeltaInput`/`decodeDelta`,
`GraphStore`, `GraphDelta`, `ChangeSet`.

**Forbidden imports:** everything except `@meridian/graph-core`. No zod, no
DOM, no `node:*` builtins (the store is isomorphic: browser, worker, Node),
no domain vocabulary, no AI, no presentation (§20 dependency law; enforced
by dependency-cruiser in CI).

Invariants owned here: U5 (total version order), U6 (invertibility), plus
incremental preservation of U1–U3/U7–U8 on every committed snapshot —
property-tested against `graph-core`'s whole-space validator (I4 and
index-vs-bruteforce suites in `test/`).
