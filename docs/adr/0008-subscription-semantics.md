# ADR-0008 — Subscription semantics: per-transaction batches, async microtask delivery, no re-entrant mutation

- **Status:** Proposed
- **Date:** 2026-07-05
- **Phase:** 1 (roadmap)
- **Constitution:** ARCHITECTURE.md P11, §1.4 (channel 3), §13.1; ADR-A2
- **Roadmap:** ROADMAP.md Phase 1 §8 (ADR-0008)

## Context

Change events are the third communication channel (§1.4): asynchronous,
post-hoc facts that never carry authority. Phase 1 needs the store-level
subscription primitive that the Phase 5+ event bus, cache invalidation (§5.5),
and `meridian watch` all build on. The constitution fixes the doctrine
(events describe the past; handlers never mutate re-entrantly); this record
fixes the mechanics.

## Decision

- **API.** `subscribe(listener: (change: ChangeSet) => void): Unsubscribe`.
  No options object in v1 — filtering, topic patterns, and replay belong to
  the event bus (§13), not the store primitive. The roadmap's sketched
  `SubscribeOpts` is finalized as *absent* until a consumer phase needs it.
- **Batching.** Exactly one `ChangeSet` per committed transaction — never
  split, never coalesced across transactions in v1.
  `ChangeSet = { fromVersion, toVersion, origin, ops, touched }` where `ops`
  are the completed (invertible) ops and `touched` holds the affected graph
  and node id sets: element ops touch their graph and element; edge ops also
  touch both endpoints; `node:detail` ops also touch the released and claimed
  child graphs. `touched` is the cache-invalidation input for P3+ (§5.5).
- **Delivery.** Asynchronous on the microtask queue: `apply` returns before
  any listener runs; batches are delivered in commit order (FIFO),
  exactly once per listener. The listener set for a commit is captured *at
  commit time*: subscribing after a commit never replays it; unsubscribing
  after a commit but before the microtask flush still receives that
  already-committed batch (events are facts about the past).
- **Containment.** A throwing listener never poisons the store, other
  listeners, or later deliveries. Exceptions are caught and routed to the
  `onListenerError` hook supplied to `createStore` (default: ignore). The
  store cannot log (no I/O in the semantic core); surfacing listener bugs is
  the host's job via the hook.
- **No re-entrant mutation.** Calling `apply`/`transact` from inside a
  listener throws `MeridianError('reentrant-mutation')`. Listeners that need
  to mutate must enqueue (schedule their own task/microtask), which is
  exactly the "handlers enqueue commands" rule (§1.4) enforced at the only
  place the store can see.

## Alternatives considered

- **Synchronous delivery.** Rejected: makes every `apply` caller re-entrant
  into arbitrary consumer code, invites mutation-during-commit bugs, and
  contradicts §13.1's async doctrine.
- **Macrotask (setTimeout) delivery.** Rejected: microtasks preserve "before
  the next await/render tick" freshness and keep CLI process-exit semantics
  simple (queued batches flush before exit).
- **Per-op events.** Rejected: transaction granularity is the semantic unit
  (U5); per-op streams shred atomicity for consumers.
- **Coalescing under load.** Deferred: a real backpressure consumer (P5
  rendering) may want it; if so it lands additively as an explicit opt-in,
  never silent behavior.
- **Allowing re-entrant writes with a work queue inside the store.** Rejected:
  hides causality and turns the store into a scheduler; the constitution puts
  queueing on the consumer side.

## Tradeoffs & consequences

- Consumers needing immediate post-commit reads use `apply`'s return value
  (it carries the completed delta and versions) rather than their listener.
- Capture-at-commit means a just-unsubscribed listener can still fire once —
  the price of "events are facts"; documented, tested.
- The error hook's default silence puts the reporting burden on hosts; the
  CLI installs a stderr hook.

## Reasoning

These are the weakest guarantees that are still exact — order, atom-per-
transaction, exactly-once — so every later layer (bus, invalidation, watch
mode, sync) can be built without re-litigating delivery semantics, while the
store stays free of scheduling policy.

## Future implications

The §13 event bus wraps this primitive into enveloped, correlation-id-carrying
topics without touching the store. P3's cache invalidation consumes `touched`
as-is. P12's remote-op application produces ordinary ChangeSets, so presence
and live co-navigation ride the same channel.
