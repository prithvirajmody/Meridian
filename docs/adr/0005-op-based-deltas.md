# ADR-0005 — Op-based deltas as the only write path; op vocabulary v1

- **Status:** Proposed
- **Date:** 2026-07-05
- **Phase:** 1 (roadmap)
- **Constitution:** ARCHITECTURE.md P2, §1.4 (channel 2), §3.1 (History), §3.2 (U5, U6), §3.3; ADR-A2
- **Roadmap:** ROADMAP.md Phase 1 §7–8 (ADR-0005)

## Context

Undo/redo, incremental view updates, autosave, crash recovery, diffing, audit,
and future multiplayer are all projections of one ordered, invertible operation
log (ADR-A2). The constitution fixes the stance ("all mutation is typed,
invertible ops"); this record finalizes the concrete op vocabulary, the delta
envelope, invertibility mechanics, and the wire form that `meridian mutate`
scripts use.

## Decision

**One write path.** `@meridian/graph-store` owns all mutation. A space enters a
store via `createStore(space)` (validated once); every change thereafter is a
`GraphDelta` applied atomically through `apply`/`transact`. There is no other
mutation API, for anyone, ever (§3.3). `graph-core`'s pure builders remain what
they are — constructors of *pre-store* values (fixtures, tests, adapters
assembling input) — not a second write path into a store.

**Op vocabulary v1 — nine ops.** Payload shapes reuse `graph-core` model types:

| Op | Payload | Inverse |
|---|---|---|
| `graph:add` | `graph`, `meta: GraphMeta` (new graph is empty, becomes a root) | `graph:remove` |
| `graph:remove` | `graph`, `prev: GraphMeta` (graph must be empty and a root) | `graph:add` |
| `graph:meta` | `graph`, `prev`, `next: GraphMeta` | swap `prev`/`next` |
| `node:add` | `graph`, `node: SemanticNode` | `node:remove` |
| `node:remove` | `graph`, `id`, `prev: SemanticNode` (node must have no incident edges) | `node:add` |
| `node:attr` | `graph`, `id`, `key`, `prev?`, `next?: AttrValue` (absent = key absent) | swap `prev`/`next` |
| `node:detail` | `graph`, `id`, `prev?`, `next?: GraphRef` (absent = no detail) | swap `prev`/`next` |
| `edge:add` | `graph`, `edge: SemanticEdge` | `edge:remove` |
| `edge:remove` | `graph`, `id`, `prev: SemanticEdge` | `edge:add` |

- `node:remove` requires no incident edges (a delta removes them first;
  `GraphTransaction.removeNode` cascades that automatically). `graph:remove`
  requires the graph to be empty and unclaimed. Removing/clearing the detail of
  a node releases the child graph back to root status.
- Changing a node's `kind`/`label`/`provenance` is **remove + re-add** in v1.
  The vocabulary is versioned and strictly additive; cheap field ops
  (`node:label`, `node:move`) are anticipated for the phase that first needs
  them (P7/P8), per the roadmap's additive-vocabulary rule.

**Canonical vs input form.** Committed ops always carry `prev` payloads —
that is what makes every committed delta invertible (U6, I4). Submitted ops
may omit them:

- Input removes may state just `graph` + `id`; input `node:attr`/`node:detail`
  may state just `next`; input `graph:remove` may omit `prev`.
- `apply` *completes* each op from current state and returns the completed,
  invertible `GraphDelta` in its result (and in the `ChangeSet`).
- Where an input op *does* carry `prev`, it is an **assertion**: mismatch with
  actual state rejects the delta (`op-conflict`). Replaying an inverted or
  logged delta therefore gets full conflict detection for free. (One known
  soft spot: an input `node:attr` cannot assert "key was absent", because an
  absent `prev` means "no assertion" — acceptable, noted.)

**Delta envelope.** `GraphDelta = { baseVersion, origin, ops }`.
`baseVersion` is optional on input (when present it must equal the store's
current version exactly, else `stale-delta`); the committed delta records the
actual base. `origin: OpOrigin = { actor: string }` is **required** — history
without issuers is forbidden (§3.1 History); richer origin structure
(correlation ids, command identity) arrives with the command system/event bus
phases, additively. Empty deltas (zero ops) are rejected.

**Atomicity and error style.** `apply` validates op-by-op against a working
state; the first violation rolls everything back and reports a typed, located
issue (`opIndex`, ids, `StoreIssueCode`). Boundary *parsing* of scripts
(`decodeDeltaInput`) aggregates all structural errors, gate-style (P4).
Exceptions remain reserved for programming errors (re-entrancy, invalid
`createStore` input).

**Wire form.** A delta is JSON with the same element shapes as the document
format (ADR-0004). Because `graph-store` may import only `graph-core` (§20),
the script gate is hand-rolled (`decodeDeltaInput`/`decodeDelta`) rather than
zod-based; it applies the same NFC/number canonicalization as the document
codec (via `graph-core`'s exported canonicalizers). When Phase 2 builds the IR
gate, the delta wire form becomes the IR's delta payload — same duality the
constitution names in §6.2. A delta that crosses store sessions (a file, an
export — the *portable* form, `PortableDelta`) may omit `baseVersion`, because
stamps are per-session (ADR-0007); its completed `prev` payloads act as the
cross-session conflict guard. `meridian invert` emits exactly this form.

## Alternatives considered

- **State-based deltas (snapshot diffs).** Rejected: loses intent and origin,
  makes inverses and merges quadratic, and collapses the op log into blobs.
  `diffSpaces` exists as a *utility producing ops* for adapters that cannot
  emit ops natively — the log stays op-based.
- **Direct mutable API with dirty tracking.** Rejected per ADR-A2: every
  roadmap feature above would need its own mechanism.
- **Domain-event sourcing (high-level events).** Rejected: the core is
  domain-blind (P1); low-level typed ops are the only vocabulary the waist may
  know.
- **Always-required `prev` on input.** Rejected: makes hand-written scripts
  reproduce entire payloads; the store already knows them.
- **Two disjoint op type families (input vs committed).** Rejected in favor of
  "canonical is a valid input whose `prev`s are assertions" — one vocabulary,
  replay safety for free.

## Tradeoffs & consequences

- Every writer pays op-vocabulary discipline; multi-field edits are several
  ops. In exchange: undo, audit, diff, incremental invalidation, and P12 sync
  are one mechanism.
- Remove+re-add for core-field changes bloats deltas slightly until a
  dedicated op is justified by a real consumer.
- First-error reporting on apply (vs aggregate) trades completeness for
  well-defined sequential semantics.

## Reasoning

The vocabulary is the smallest set that spans the model (graphs, nodes, edges,
attrs, containment) and satisfies I4 mechanically. Nine ops cover everything
Phase 1–3 needs; additivity is the pressure valve for later phases. Completion-
with-assertions reconciles the two masters — hand-writable scripts and
self-contained invertible logs — without a second vocabulary.

## Future implications

P2 adapters emit these deltas through the ingest sink; P3 proposals become
ordinary deltas (AI gets no special write path); P11 persists the completed
deltas as the durable op log; P12 replicates them. Vocabulary changes are
additive and versioned forever.

## Open questions for review

1. **`graph:meta` op.** Added beyond the roadmap's eight sketched ops so
   `diffSpaces` can express metadata changes without dropping/recreating a
   whole graph. Confirm.
2. **Origin minimalism.** `{ actor: string }` now, extended additively later.
   Confirm, or require a structured origin (kind + actor) from day one.
