# ADR-0010 — plugin-api versioning policy

- **Status:** Proposed
- **Date:** 2026-07-05
- **Phase:** 2 (roadmap)
- **Constitution:** ARCHITECTURE.md §3.3 (no unversioned external surface), §14.2, P12
- **Roadmap:** ROADMAP.md Phase 2 §8 (ADR-0010)

## Context

`@meridian/plugin-api` is an external surface from the moment it exists:
adapters — ours today, third parties' later — compile against it, and manifests
declare compatibility with it. The constitution forbids unversioned external
surfaces (§3.3). What must be fixed now is the compatibility discipline that
plugin authors can rely on while the contract is still learning from real
domains (Phases 7 and 9 are scheduled amendment checkpoints).

## Decision

**Semver, with declared breaking-change checkpoints.**

1. `plugin-api` carries a semver version, exported at runtime as
   `PLUGIN_API_VERSION`. Every manifest declares `apiVersion`: a semver range
   the plugin was built against. The host refuses to activate a plugin whose
   range does not accept the running version — a typed manifest error, not a
   crash at first call.
2. **Pre-1.0 rules (now → Phase 9):** the API lives at `0.x`. Minor bumps
   (`0.2.0`) may break; patch bumps never do. Range checking honors the 0.x
   caret convention: `^0.2.1` accepts `>=0.2.1 <0.3.0`.
3. **Breaking changes happen only at declared checkpoints** — the scheduled
   contract amendments at Phase 7 (code domain) and Phase 9 (AI-native
   domains), after which the API freezes at 1.0. Between checkpoints, changes
   are additive only: new capability kinds, new optional fields.
4. Every change is recorded in `packages/plugin-api/CHANGELOG.md` (per-package
   changelogs are mandatory from this phase, ROADMAP §5.4), and the public
   surface is snapshot-tested so an accidental break fails CI before it
   reaches a consumer.

## Alternatives considered

- **No versioning until 1.0** ("it's all first-party anyway"). Rejected:
  violates §3.3, and the discipline is precisely what the pre-1.0 phase is
  supposed to rehearse — we are our own first plugin authors.
- **API version as an integer epoch** (like `formatVersion`). Rejected: the
  document format has one producer chain and migrations; the plugin API has
  independent consumers needing range expression — semver is the ecosystem
  convention those consumers already understand.
- **Break freely until 1.0, no checkpoints.** Rejected: Phases 3–6 build on
  the contract in parallel with domain work; undeclared churn would tax every
  track. Checkpoints make amendment windows explicit and reviewable.

## Tradeoffs & consequences

Additive-only between checkpoints means contract mistakes discovered
mid-stream are worked around (deprecation, parallel field) rather than fixed
immediately — some temporary ugliness in exchange for parallel tracks never
being broken by the contract under their feet. Hand-rolled range checking (the
host supports exact versions and caret ranges only) avoids a dependency; the
narrowness is documented in the manifest reference.

## Reasoning

The plugin API is the one surface where "we can refactor freely" is false by
design — the conformance kit, adapters, and eventually third parties all sit
on it. Semver plus checkpoints is the smallest policy that keeps evolution
possible while making compatibility a checkable, refusable fact at
registration time.

## Future implications

Phase 9 freezes the contract at 1.0; from then on breaking changes require a
major bump and a migration note per §14.2's api-extractor-style surface
checking. The manifest's `apiVersion` field is also the future registry's
compatibility filter (Phase 12).
