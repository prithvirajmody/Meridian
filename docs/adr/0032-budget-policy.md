# ADR-0032 — Budget policy: per-project/per-session ceilings, hard-stop that preserves valid partial graph state, provider-neutral accounting

- **Status:** Proposed
- **Date:** 2026-07-13
- **Phase:** 8 (roadmap)
- **Constitution:** ARCHITECTURE.md §8.3.3 (budget guard — hard stop mid-operation leaves valid, partially-enriched state, clearly marked; continuing is an explicit user decision), §8.1 (deterministic floor); ADR-A5
- **Roadmap:** ROADMAP.md Phase 8 §3 (`BudgetGuard`, hard-fail), §8 (ADR-0032), §11 (budget trip leaves valid partial graph), §12 (BudgetGuard state machine; budget exhaustion failure case)
- **Related:** ADR-0029 (normalized usage feeds the meter), ADR-0030 (replayed calls are metered too), ADR-0031 (partial results are tagged proposals like any other)

## Context

Cost is AI's biggest operational liability (ROADMAP §2 motivation; §9 risk b). The
constitution makes the **budget guard** a non-negotiable gateway service that
**hard-stops mid-operation, leaving valid, partially-enriched state clearly marked,
with any decision to continue made explicitly** (§8.3.3). Phase 8 builds
`BudgetGuard` and must prove a *budget trip mid-run leaves a valid, partially
enriched graph* (§11 acceptance; §12 verification). This record fixes the ceilings,
the hard-stop semantics, and — critically — the invariant that a stop never corrupts
graph state, aligned with the provider-neutral usage accounting of ADR-0029.

## Decision

**Ceilings are per-project and per-session, in tokens and currency.** `BudgetGuard`
enforces configurable ceilings at two scopes (§8.3.3): a **per-session** ceiling
(one `meridian ai …` invocation / one interactive operation) and a **per-project**
ceiling (cumulative). The CLI surfaces a session ceiling directly
(`meridian ai summarize --budget 2.00`, ROADMAP §6). Ceilings are configuration, not
code.

**Implementation status:** Phase 8 currently embodies the per-session guard and
CLI ceiling only. A durable cumulative per-project meter is not present, so this
ADR remains **Proposed** rather than claiming the full constitutional two-scope
decision is accepted.

**Accounting is provider-neutral.** The meter consumes the **normalized `usage`**
each adapter returns (ADR-0029: `{ inputTokens, outputTokens, … }`) and the model's
cost/token from its capability descriptor, so cost is computed the same way whichever
vendor answered. Replayed calls (ADR-0030) commit their recorded usage through the
same guard, so replayed budget state and nominal cost are deterministic even though
no provider is called and no new external charge is incurred. Ordinary live-cache
hits are free. The measured cost table (`¢/1k nodes`, DoD) is authored from live
record-mode usage, never from mock data.

**Hard stop, not degrade.** Accounting is deliberately post-hoc at call boundaries:
a completed call may reach or cross a ceiling, then `BudgetGuard` refuses the
**next** call. It does not silently downgrade the model or truncate an in-flight
result. The guard is a state machine (`ok → warned → stopped`, verifiable — §12
Unit) whose `stopped` state refuses new calls for that scope until a new session is
created with a raised/reset ceiling.

**A stop always leaves a valid, clearly-marked partial graph.** This is the core
invariant. Because AI output enters only as proposals through the one write path
(ADR-0031/ADR-0005), work already accepted before the stop is ordinary committed
graph state; work not yet done simply never entered. Concretely:
- Proposals are applied atomically per unit (per node/cut work-unit), so a stop
  falls **between** units, never inside a half-written delta. There is no partial
  op.
- Units enriched before the stop carry their normal `origin:'ai'` provenance
  (ADR-0031); un-enriched units retain their deterministic-floor content (§8.1.1 —
  summaries fall back to statistics, clustering to connectivity, etc.). The graph is
  therefore always complete and valid, just partially enriched.
- The partial state is **clearly marked**: the operation reports which units were
  enriched vs skipped-due-to-budget, so the boundary is legible (§8.3.3).

**Continuing is explicit.** After a stop the system does not auto-resume. Raising the
ceiling or explicitly re-running is a deliberate user act (§8.3.3); the next run
resumes cheaply because completed units are cache/replay hits (ADR-0030), so no work
is paid for twice.

**Warned before stopped.** The guard exposes spent tokens, spent dollars, call
count, trip state, and coarse status (`BudgetState`, ROADMAP §5/§7) so services and
UI can show progress toward a ceiling and warn before the hard stop.

## Alternatives considered

- **Soft budget (warn but never stop).** Rejected by §8.3.3: cost surprises are the
  named risk; a guard that cannot stop is not a guard.
- **Degrade-on-budget (switch to a cheaper model near the ceiling).** Rejected for
  v1: silently changing the model changes provenance and eval attribution
  invisibly; the honest behavior is stop + explicit continue. (A future
  budget-aware routing policy could opt into this per project — deferred.)
- **Roll back the whole operation on a budget trip.** Rejected: discards useful,
  already-valid enrichment and wastes spend; §8.3.3 explicitly wants the partial
  state *kept* and marked, not undone.
- **Stop mid-unit / mid-delta.** Rejected: would risk an invalid graph; the atomic
  per-unit boundary is what makes "valid partial state" true by construction.
- **Vendor-specific cost accounting.** Rejected: breaks the multi-provider seam; the
  normalized usage + descriptor cost keeps the meter vendor-blind (ADR-0029).

## Tradeoffs & consequences

Buys hard cost control, deterministic replay-mode cost, and a graph that is never
corrupted by running out of budget — the exact §11 acceptance criterion. Costs:
services must structure work into atomic units so a stop can fall cleanly between
them (a mild design constraint, and the natural batch shape anyway — summaries are
per-cut-node, clustering per group); and "partial + marked" must be surfaced in both
CLI and Studio. The warned/stopped state machine is a small amount of gateway state
to test.

## Reasoning

§8.3.3 already dictates hard-stop-with-valid-partial-state; the only design work is
making "valid partial state" *structural* rather than aspirational — which the
proposals-only write path (ADR-0031) already provides: stop between units and every
intermediate state is a legitimate graph. Provider-neutral accounting follows
directly from ADR-0029's normalized usage. Explicit-continue plus cache reuse means
budgets protect spend without punishing the user with repeated work.

## Future implications

The first required follow-up is the durable cumulative **per-project** meter needed
to complete §8.3.3 and accept this ADR. Per-project budget-aware routing (choose a
cheaper model as a ceiling nears, rather than stopping) is a separate future policy
layered on that meter and the task-class table (ADR-0029); it must keep provenance
honest about which model ran. P9 enrichment and P12 agents can use the session guard
now, but multi-session agent spend is not project-bounded until that follow-up
lands. The cost table becomes the baseline for choosing those limits.

## Resolved defaults (2026-07-13)

1. **Default ceilings:** unset means unbounded. The caller/CLI must opt into a
   per-session token or dollar cap; no price-derived default is invented before
   the live cost rows exist. The future project meter will likewise be opt-in by
   default unless a later ADR changes that policy.
2. **Warn threshold:** `0.8` (80%) by default, configurable per guard through
   `warnThreshold`.
