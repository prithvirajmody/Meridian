# ADR-0009 — Plugin loading model: in-process packages, isolation-shaped contract

- **Status:** Proposed
- **Date:** 2026-07-05
- **Phase:** 2 (roadmap)
- **Constitution:** ARCHITECTURE.md §7.1–7.2, §14.2–14.4 (trust tiers), P5
- **Roadmap:** ROADMAP.md Phase 2 §8 (ADR-0009)

## Context

Phase 2 introduces the L1/L2 boundary: plugins contribute capabilities (first:
`domain-parser`) through a versioned contract. The constitution fixes the trust
tiers (§14.4): Tier 0 built-ins are in-process; Tier 1 third-party plugins are
worker-isolated *later*. What must be decided now is how plugins load for the
entire pre-M4 life of the project, and which contract constraints are written
today so that isolation later is a host change, not a plugin change.

## Decision

**In-process npm packages, statically imported by the host application, for
all plugins until Phase 12.** A plugin is a workspace package exporting one
`MeridianPlugin` value: a manifest plus an `activate(ctx)` function. The
composition root (the CLI now, Studio later) imports plugin modules and hands
them to `registerPlugin`; the host validates the manifest, checks the declared
`apiVersion` range against the running `plugin-api` version, and only then
activates.

The isolation-shaped constraints are contract law from day one:

1. **No module-scope side effects.** Importing a plugin module does nothing.
   All work happens inside `activate` or capability calls.
2. **Everything through the injected `PluginContext`.** Plugins receive
   capability-scoped facades (v1: deterministic ID derivation, a logger).
   No store references, no host internals, no ambient authority.
3. **Message-friendly payloads only.** Everything a plugin emits or receives
   (`SourceDescriptor`, `GraphDocument`, `GraphDelta`, progress, reports) is
   structured-clone-safe JSON. No live objects, callbacks-as-data, or shared
   mutable state cross the boundary — the future worker boundary is already
   the shape of the API.
4. **Failure isolates.** A plugin that throws — in `activate`, `sniff`, or
   mid-ingest — is contained by the host: its error is captured as a typed,
   located report; buffered emissions are discarded (atomic rollback); the
   host and other plugins are unaffected.

## Alternatives considered

- **Worker isolation now.** Rejected: pays the serialization/lifecycle tax
  through ten phases in which every plugin is our own reviewed code (Tier 0),
  and the roadmap explicitly schedules isolation for Phase 12.
- **Dynamic loading (`import()` from paths/registry) now.** Rejected: a
  distribution mechanism with no distribution problem; static workspace
  imports keep the type system and depcruise watching the boundary.
- **Contract without the isolation constraints** ("clean it up when workers
  arrive"). Rejected: retrofitting serializability onto a chatty object API is
  a rewrite (§14.4); the constraints cost little now.

## Tradeoffs & consequences

A crashing plugin *can* corrupt in-process memory in ways a worker could not —
accepted for Tier 0 (our code, reviewed as such). Error isolation is by
convention-plus-catch, not by process boundary; the conformance kit and host
tests exercise it. In exchange: zero serialization overhead, ordinary
debugging, and the full toolchain (typecheck, depcruise) enforcing the
boundary.

## Reasoning

The dependency law makes the boundary mechanical: adapters may import only
`plugin-api`, so domain knowledge *cannot* leak into the core even though
everything shares a process. Process isolation adds safety, not architecture —
and safety is not yet the binding constraint.

## Future implications

Phase 12 moves Tier 1 plugins behind a structured-clone worker boundary by
changing only the host's dispatch; plugins compiled against `plugin-api`
continue to work because rules 1–3 already made them message-shaped. The
`PluginContext` facade list is the future permission surface.
