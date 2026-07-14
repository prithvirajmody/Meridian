# ADR-0033 — plugin-api 1.0 scope: which surface freezes, additive-only until 2.0, deprecation policy

- **Status:** Proposed
- **Date:** 2026-07-14
- **Phase:** 9 (roadmap)
- **Constitution:** ARCHITECTURE.md §3.3 (no unversioned external surface), §14.1 (enumerated capability kinds, extended deliberately), §14.2 (manifest + contract, api-extractor-style surface checking), §20 (dependency law — adapters/plugins see only `plugin-api`), P12 (interfaces are versioned contracts)
- **Roadmap:** ROADMAP.md Phase 9 §5 (chafe report), §6 (plugin-api 1.0 semver-guarded by api-extractor), §8 (ADR-0033), §12 (Architecture row — api-extractor 1.0 snapshot gate)
- **Related:** ADR-0010 (semver + declared checkpoints — this is the Phase 9 freeze it scheduled), ADR-0005 (the one write path — `plugin-api` is a type contract, never a write path), ADR-0029/0030/0031/0032 (the AI gateway lives *behind* the seam, so its types stay off the frozen surface)

## Context

ADR-0010 (itself still **Proposed**) scheduled `plugin-api` for semver with two
declared breaking-change checkpoints — Phase 7 (code domain) and Phase 9
(AI-native domains) — "after which the API freezes at 1.0." Phase 9 is that
second checkpoint. Two structurally different domains are already live against
the contract (tree-ish markdown, dense-graph code); the AI-native discourse
domains — conversation and argument — are **implemented across 9B through 9D,
not yet live**, so the roadmap's "rule of three" (§2, §5) is **not yet
satisfied**. The freeze is therefore contingent: it can seal the contract only
once those adapters pass and the 9E chafe audit clears. Freezing means two
concrete commitments a plugin author can rely on: an **exact surface** that
will not shrink or shift under them, and an **additive-only** evolution policy
until a deliberate 2.0. §3.3 forbids an unversioned external surface; P12
makes the frozen surface a CI-checkable fact via api-extractor.

This record fixes *what* freezes and the compatibility rules. Its exact scope
is **provisional** until the 9E chafe report (ROADMAP §5) audits every place
the contract chafed across markdown, code, conversation, and argument —
including the Phase 7F `DetailResolver` addition — and each chafe item is
fixed pre-freeze or explicitly deferred. ADR-0033 is drafted now and
**finalized in 9E** with those dispositions and the migration notes folded in;
the freeze itself (api-extractor snapshot becomes a CI contract, `plugin-api@1.0`
tag) happens in 9E, not here.

## Decision

**The frozen surface is the exported symbols of `@meridian/plugin-api`.** The
plugin-author contract is exactly what `packages/plugin-api/src/index.ts`
re-exports — nothing more, nothing less — because §20 guarantees adapters and
third-party plugins see *only* this package. As of this draft that surface is:

- **Re-exported `graph-core` wire types** that plugins build IR against
  (`AttrValueType`, `GraphDocument`, `SemanticCoords`) — frozen *as
  re-exported through `plugin-api`*, because to a plugin author they are part
  of this contract even though they physically originate in `graph-core`.
- **Capability contracts:** `DomainParser`, `IncrementalAdapter`,
  `DetailResolver`, `AbstractionProvider`, `LayoutProvider`, and their
  associated type families (`IngestSink`/`IngestReport`/`DeltaWire`/
  `ProvenanceTally`; `DetailContext`/`DetailNode`/`DetailGraphRef`;
  `AbstractionContext`/`AbstractionProposal`/`ProposedGroup`; the `Layout*`,
  `Point`/`Rect`/`Size` geometry types).
- **Manifest and context contracts:** `PluginManifest`,
  `CapabilityDeclaration`, `AttrSchema`, `LevelChainSpec`/`LevelSpec`,
  `PluginContext`/`PluginLogger`/`IdFacade`/`EdgeCoords`, `MeridianPlugin`/
  `PluginExports`, `SourceDescriptor`/`SourceChange`/`Progress`; and
  `CapabilityKind`, a **type-only** export (the union derived from the
  `CAPABILITY_KINDS` runtime tuple, carrying no runtime value of its own).
- **Runtime values:** `CAPABILITY_KINDS`, `NAMESPACED_KEY_PATTERN`,
  `PLUGIN_API_VERSION`.

**`DetailResolver` is provisionally included.** It was added to `plugin-api`
in 7F as the first post-P2 contract change (a minor bump, flagged for this
chafe report). It is a public capability plugins can implement, so it belongs
inside the freeze *unless* the 9E audit finds a reason to reshape it first.

**What does not freeze.** The 1.0 freeze is the plugin-author contract, not a
whole-repo freeze:
- It does **not** automatically freeze every public `graph-core` symbol — only
  those graph-core wire types actually re-exported through `plugin-api`. A
  separate whole-graph-core freeze must not be assumed without a reviewed
  reason; the api-extractor rollup for `plugin-api` is the mechanical contract.
- It does **not** freeze internal AI, app (`studio`/`cli`), `abstraction`, or
  plugin-**host** APIs — those are internal seams, versioned by their packages,
  not the plugin contract.
- `GraphProposal` and all `ai-services` types remain **outside** `plugin-api`
  (they live behind the gateway, ADR-0029/0031; ADR-0034 keeps enrichment out
  of the adapter package). The seam is not widened merely because AI-native
  domains exist.

**The mechanical contract is the 9E api-extractor rollup.** §14.2 mandates
api-extractor-style surface checking on our side; 9E makes the `plugin-api`
rollup report a committed CI artifact. From 1.0 on, **accidental drift fails
CI** before it reaches a consumer (§3.3, P12).

**Compatibility policy — additive-only until 2.0.**

- *Allowed in a 1.x minor (non-breaking):* new exports; new capability kinds
  (the §14.1 enum is extended deliberately, per phase); new **optional** fields
  on existing types.
- *Requires 2.0 (breaking):* removing or renaming an export; making an
  existing field required; narrowing a type; changing call semantics or a
  capability's lifecycle; any semantic change that invalidates a
  previously-compliant plugin.
- *Deprecation* is announced simultaneously in docs, in type annotations
  (`@deprecated`), and in `packages/plugin-api/CHANGELOG.md` within a minor;
  the replacement is additive; a deprecated member is **not removed before
  2.0**.
- *Process:* every intentional surface change regenerates the committed
  api-extractor report through the documented regen command (never by hand),
  and carries a changelog entry plus a compatibility review. This is the
  api-extractor discipline ADR-0010 §4 promised, now made a hard 1.0 gate.

**Relationship to ADR-0010 and existing manifests.** Under the host's semver
rules (ADR-0010 §2), a caret range on a 0.x version does not cross to 1.0:
`^0.2.x` accepts `>=0.2.0 <0.3.0` and therefore **excludes** 1.0. So existing
0.2 plugin manifests do **not** satisfy 1.0 even when they are source-
compatible — the host will refuse to activate them against a 1.0 runtime with
a typed manifest error, not a crash. **Migration** is: rebuild against 1.0,
pass conformance, then update the manifest's `apiVersion` to `^1.0`. This
record deliberately does not claim "0.2 manifests load unchanged"; it states
the true relationship and defers the concrete migration notes to the 9E
finalization. Because ADR-0010 is itself still **Proposed**, the 9E step that
finalizes ADR-0033 must also reconcile ADR-0010's status — accepting,
superseding, or otherwise resolving it — so the freeze does not rest on an
un-accepted policy record.

## Alternatives considered

- **Freeze the entire public `graph-core` surface too.** Rejected: `graph-core`
  has internal consumers (`graph-store`, `abstraction`, the codec/gate) that
  must keep evolving; only the symbols re-exported through `plugin-api` are the
  plugin-author contract. Freezing more would either over-constrain the core or
  smuggle un-audited symbols into the 1.0 promise.
- **Include `ai-services`/`GraphProposal` in the frozen surface.** Rejected:
  those are gateway-side types (ADR-0029/0031), reached through the AI job
  pathway, not compiled against by parser/projection/layout plugins. Freezing
  them would widen the seam exactly where ADR-0034 works to keep it narrow.
- **Grandfather 0.2 manifests as 1.0-compatible.** Rejected: it contradicts
  ADR-0010's host range rules (caret 0.2 excludes 1.0) and would make the
  freeze a fiction — the whole point of a version gate is that compatibility
  is a checkable, refusable fact at registration.
- **Stay pre-1.0 indefinitely (never freeze).** Rejected: P12 and ADR-0010
  scheduled this freeze for the phase the rule of three is met; perpetual 0.x
  denies plugin authors the stability the contract exists to give.
- **Freeze now, skip the chafe audit.** Rejected: ROADMAP §9 risk (b) is
  "freezing the API too early with un-chafed corners"; the mandatory chafe
  report is the mitigation, so 1.0 is drafted now but sealed only after 9E.

## Tradeoffs & consequences

Buys plugin authors a stable, snapshot-guarded contract and buys the project a
CI tripwire against accidental breakage. Costs: additive-only means any design
mistake surviving into 1.0 is carried (via deprecation + parallel field) until
a deliberate 2.0, rather than fixed in place; and every intentional surface
edit now pays the api-extractor regen + changelog + review tax. The manifest
migration (caret 0.2 → caret 1.0) is a one-time, mechanical break for existing
first-party adapters, made visible and safe by conformance.

## Reasoning

§3.3 forbids an unversioned external surface and P12 makes the surface a
tested contract; ADR-0010 already chose semver-with-checkpoints and named
Phase 9 as the freeze. The only genuinely open work is *scope* — and the
honest scope is "what a plugin actually compiles against," which §20 pins to
`plugin-api`'s exports. Keeping the AI surface off the freeze follows directly
from the gateway architecture (ADR-0029/0031) and from ADR-0034's rule that
adapters never call AI or hold a store. Additive-only-until-2.0 is the
smallest policy that lets the contract keep growing without ever breaking the
code written against it.

## Future implications

Once sealed in 9E, `plugin-api@1.0` is the compatibility baseline the Phase 12
registry filters on and the surface third-party authors build against with
confidence. New capability kinds (view projections in P10, sync-facing
contributions later) arrive as additive 1.x minors; the first genuinely
breaking need opens a reviewed 2.0 with migration notes. The api-extractor
report becomes a permanent CI gate, so "we can refactor freely" stays false
here by design — exactly the one place it should be.

## Open questions for review

1. **Exact frozen export list + chafe dispositions.** The surface above is the
   current `index.ts`; the *final* frozen list is settled in 9E after the chafe
   report audits markdown/code/conversation/argument and 7F's `DetailResolver`,
   fixing or explicitly deferring each chafe item. Confirm that ADR-0033 is
   finalized (Proposed → Accepted) only in that 9E step, carrying the
   dispositions and migration notes.
2. **`DetailResolver` inclusion.** Confirm `DetailResolver` (and its
   `DetailContext`/`DetailNode`/`DetailGraphRef` types) is inside the 1.0
   freeze, versus being reshaped or held back by the chafe audit first.
3. **M3 demo path.** ROADMAP §13 writes the three-domain demo to
   `docs/meridian/demos/m3.md`; SUBPHASES §9E writes it to `docs/demos/m3.md`.
   The existing repo convention is `docs/demos/` (`m1.md`, `m2.md`,
   `phase-0N.md` all live there). **Recommend `docs/demos/m3.md`** and treat
   the ROADMAP path as a typo to reconcile at the 9E gate.
