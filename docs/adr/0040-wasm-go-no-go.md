# ADR-0040 — WASM go/no-go: the measured criteria (decision deferred to 11G)

- **Status:** Proposed — **criteria only; the go/no-go decision is made in
  subphase 11G from this phase's measured numbers** (roadmap §8: "decided in
  11G from measured data")
- **Date:** 2026-07-16
- **Phase:** 11 (roadmap)
- **Constitution:** ARCHITECTURE.md §16.3 (measurement discipline), §16.1; ADR-A12
- **Roadmap:** ROADMAP.md Phase 11 §4, §8 (ADR-0040); SUBPHASES.md 11A/11G

## Context

The roadmap deliberately deferred Rust/WASM until Phase 11 proves a need
(technology table: "premature WASM would tax every contributor"). ADR-A12
fixes the escalation doctrine: a hot path resisting JS-level optimization may
be ported behind its existing pure interface, gated on measured need. This
record pins *what counts as measured need* before the benchmark data exists,
so the 11G decision is a table lookup, not a debate.

## Decision

**Candidates.** A WASM port may be considered only for a **pure,
synchronous, interface-stable computation** already isolated behind a typed
seam. The pre-identified candidates (§16.3): induced-edge aggregation
(`aggregateEdges`), the seeded force layout, and — if profiles surprise us —
any similarly pure kernel (e.g. content-hash derivation). UI, I/O, store
mutation, and anything touching the DOM/pixi are ineligible.

**Go criteria — all five must hold, measured on the pinned CI runner class
at 11G:**

1. **A budget is failing or critical:** a `benchmarks/budgets.json` row is
   red, or has < 1.25× headroom *and* a regression trend across the phase's
   CI history.
2. **The kernel is the cause:** a committed profile attributes ≥ 60% of the
   failing scenario's self-time to the candidate computation.
3. **JS remedies are exhausted:** an algorithmic pass (complexity, data
   layout — typed arrays / SoA, allocation discipline) has been made and
   documented in the profiling docs, and the row still fails criterion 1.
4. **A spike proves the win:** a throwaway WASM port of the kernel (not the
   integration) beats the optimized JS by ≥ **3×** on the failing scenario's
   workload; anything less will be eaten by boundary-crossing and toolchain
   cost.
5. **Equivalence is provable:** the seam has golden/property tests strong
   enough to demonstrate the port is observably identical (determinism
   included — same results on Node and browser WASM runtimes).

**No-go otherwise** — in particular, a merely-tight-but-green budget or an
unprofiled hunch is a no-go by construction.

**If go:** one Rust crate per kernel behind the existing pure interface; the
JS implementation remains as reference + fallback and the equivalence suite
runs both; the WASM artifact loads through the same worker infrastructure as
other compute (ADR-0017); CI builds are hermetic (pinned toolchain).

**How the decision is recorded:** 11G amends this ADR in place with the
measured table (budget rows, profiles, spike numbers if any) and flips the
status to **Accepted — go (scope: …)** or **Accepted — no-go (re-evaluate
when a criterion-1 event occurs)**.

## Alternatives considered

- **Decide now (either way).** Rejected: deciding without 11G's numbers is
  exactly the speculation the roadmap forbids in both directions.
- **Lower spike bar (e.g. 1.5×).** Rejected: JS↔WASM boundary costs and a
  second toolchain are only worth paying for multiples, not margins.
- **SIMD/WebGPU compute as first escalation.** Out of scope for this record;
  either would be weighed as a "JS remedy" alternative under criterion 3 if
  applicable to a kernel.

## Tradeoffs & consequences

Pre-committing the bar means 11G cannot rationalize a pet port (cost: less
discretion; benefit: no toolchain tax without proof). The 3× spike bar may
leave a persistently-tight budget unported — that is intended: tight-but-green
is what budgets are for.

## Reasoning

ADR-A12's doctrine is that unmeasured requirements are fiction; the same
applies to unmeasured optimizations. Fixing thresholds before data exists is
the only way the eventual decision is credibly evidence-driven.

## Future implications

If no-go: the criteria stay armed permanently; any future criterion-1 event
re-opens the question through a superseding amendment. If go: the ported
kernel's budget rows become its permanent regression contract, and the crate
is the template for any later port.
