# ADR-0007 — Version stamps: monotonic per-store counter with a reserved site component

- **Status:** Proposed
- **Date:** 2026-07-05
- **Phase:** 1 (roadmap)
- **Constitution:** ARCHITECTURE.md §3.1 (Versioning), §3.2 (U5), §12.3, §21 (collaboration)
- **Roadmap:** ROADMAP.md Phase 1 §8 (ADR-0007)

## Context

Every snapshot, cache entry, layout, and View pin references a version
(§3.1); deltas state the version they apply against; P12 collaboration must
*extend* this identity scheme, not replace it (§12.3 fixes op-log replication
as the future sync design). U5 demands a total order with no torn reads.

## Decision

```
VersionStamp = { counter: number, site: string }
```

- **`counter`** — monotonic, starts at 0 when a store is created, advances by
  exactly 1 per committed transaction (one delta = one transaction = one
  stamp). Rejected deltas never advance it.
- **`site`** — the reserved multi-writer component. In v1 it is always the
  constant `'local'`; Phase 12 assigns real site ids and extends ordering to
  Lamport `(counter, site)` pairs. Reserving the field now means P12 extends
  the type's *semantics*, not its shape — no migration of stamped artifacts.
- **Ordering & equality.** `compareVersions` orders by counter, tie-breaking
  on site (total order, U5); equality is both fields. `successorVersion`
  returns `{ counter + 1, site }` — exported because `invertDelta` must
  compute, purely, the version its inverse applies against: a delta taking
  the store v→v′ has an inverse whose `baseVersion` is v′ = successor(v).
- **Scope: one store session.** Stamps identify states within the lifetime of
  a store instance. Durable stamps arrive with the persistent op log (P11,
  §15.2); nothing in v1 may persist a stamp and expect it to survive a
  reload.
- **Staleness rule.** A submitted delta carrying `baseVersion` is rejected
  unless it equals the store's current version exactly (`stale-delta`).
  Rebase/merge of stale deltas is explicitly P12's problem; v1 refuses rather
  than guesses.
- **Composition note.** `composeDeltas(d₁, d₂)` yields one delta; applying it
  advances the counter once, where applying d₁ then d₂ advanced it twice.
  Version trajectories are not preserved by composition — equality claims
  (I4 and friends) are always about *spaces*, never about stamps.

## Alternatives considered

- **Plain integer version.** Rejected: P12 would have to change the type
  everywhere stamps are stored; a reserved field costs nothing now.
- **Content hash of the space.** Rejected as the identity: hashing 100k nodes
  per commit violates budgets, and identical states reached by different
  histories *should* be distinguishable in an op-log world (the log is the
  primary artifact, §15.2). Content hashes remain available as cache keys
  where wanted.
- **UUID per commit.** Rejected: unordered, so U5's total order would need a
  side structure anyway.
- **Full vector clocks now.** Rejected: machinery for a multi-writer world
  that doesn't exist yet; Lamport-style `(counter, site)` is the agreed P12
  extension point.

## Tradeoffs & consequences

- Per-session stamps mean caches keyed by version are per-session too — fine
  until P11, which owns durability.
- Strict base-version equality makes concurrent writers impossible by
  construction in v1 — that is the intended single-writer discipline (§12.3),
  not an accident.

## Reasoning

The stamp does exactly what U5 and the roadmap ask — total order, cheap
advance, atomic association with one committed delta — while carrying the one
field P12 provably needs. Everything speculative is excluded.

## Future implications

P11 persists `(stamp, delta)` pairs as the op log; P12 turns `site` into a
real identity and adds sequencing; diff layers ("compare with yesterday",
§10.2) address version ranges by these stamps. The successor function's purity is
what keeps `invertDelta` a pure value transformation.
