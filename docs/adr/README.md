# Architectural Decision Records

A decision is **finalized only when its ADR is merged here** (CLAUDE.md hard
rule; ROADMAP.md §5.1.5). A decision without a merged ADR is a draft, no matter
how settled it feels.

These records elaborate the constitution's founding decisions
([ARCHITECTURE.md → Architectural Decision Records](../ARCHITECTURE.md#architectural-decision-records-adrs),
entries `ADR-A1…A12`) into implementation-grade commitments. Where a numbered
roadmap ADR maps onto a constitution entry, the mapping is noted in the record.
**The constitution wins every conflict** until amended through its own
amendment procedure.

## Format

One file per decision: `NNNN-kebab-title.md`, ~1 page. Each record carries a
metadata header and then the constitution's five-part frame (Decision,
Alternatives, Tradeoffs, Reasoning, Future implications), preceded by a Context
paragraph and — where a sub-decision is genuinely open — an *Open questions for
review* section.

```markdown
# ADR-NNNN — Title

- **Status:** Proposed | Accepted | Superseded by ADR-XXXX
- **Date:** YYYY-MM-DD
- **Phase:** N (roadmap)
- **Constitution:** ARCHITECTURE.md §§…, ADR-A#
- **Roadmap:** ROADMAP.md Phase N §8

## Context
Why this decision is forced now, and the constraints already fixed above it.

## Decision
What we commit to. Concrete enough to implement and to test against.

## Alternatives considered
Each rejected option with the reason it lost.

## Tradeoffs & consequences
What this costs us and what it buys us.

## Reasoning
Why the decision follows from the constraints and the requirements.

## Future implications
What it enables, and what it locks us into.

## Open questions for review  *(optional)*
Sub-decisions flagged for the human reviewer before acceptance.
```

Lifecycle: a record is **Proposed** when drafted, **Accepted** when the reviewer
approves it (edit the status line in the merging change), and **Superseded** only
by a later ADR that names it — records are never edited away, only sup*erseded*,
so the decision history stays legible.

## Registry

| ADR | Title | Status | Constitution | Phase |
|---|---|---|---|---|
| [0001](0001-recursion-representation.md) | Recursion representation: flat GraphSpace with reference-based recursion | Proposed | ADR-A1, §4 | 0 |
| [0002](0002-identity-deterministic-ids.md) | Identity: deterministic, content-addressed IDs | Proposed | §3.1 (Identity), U4 | 0 |
| [0003](0003-attribute-typing.md) | Attribute typing: typed core keys + namespaced extension bag | Proposed | §3.1 (Metadata), U8 | 0 |
| [0004](0004-document-format-and-versioning.md) | Document format & versioning policy | Proposed | ADR-A4, §6 | 0 |
| [0005](0005-op-based-deltas.md) | Op-based deltas as the only write path; op vocabulary v1 | Proposed | ADR-A2, P2, U5–U6 | 1 |
| [0006](0006-cow-structural-sharing.md) | Copy-on-write snapshots: graph-granular structural sharing | Proposed | P3, P13, §4.1 | 1 |
| [0007](0007-version-stamps.md) | Version stamps: monotonic counter + reserved site component | Proposed | §3.1 (Versioning), U5 | 1 |
| [0008](0008-subscription-semantics.md) | Subscription semantics: batched, async, non-re-entrant | Proposed | P11, §1.4, §13.1 | 1 |
| [0009](0009-plugin-loading-model.md) | Plugin loading model: in-process packages, isolation-shaped contract | Proposed | §7.1–7.2, §14.2–14.4, P5 | 2 |
| [0010](0010-plugin-api-versioning.md) | plugin-api versioning policy: semver with declared checkpoints | Proposed | §3.3, §14.2, P12 | 2 |
| [0011](0011-capability-model.md) | Capability model: enumerated kinds, extended per phase | Proposed | §14.1, §14.3 | 2 |
| [0012](0012-zoom-semantics.md) | Zoom semantics: continuous scalar → discrete level cut, hysteresis + per-node overrides | Proposed | §5.1, §5.4, ADR-A3 | 3 |
| [0013](0013-induced-edge-aggregation.md) | Induced-edge aggregation: group by kind, sum weight, cap witnesses, exact ChangeSet invalidation | Proposed | §5.3, §5.5, ADR-A3 | 3 |
| [0014](0014-node-budget-salience.md) | Node budget & salience v1: collapse lowest-salience subtrees, coverage wins over budget | Proposed | §5.1, §8.1, ADR-A3 | 3 |
| [0015](0015-coordinate-system-units.md) | Coordinate system & units: world-space float64, y-down, renderer owns pixels | Proposed | §20, §5.1, ADR-A1 | 4 |
| [0016](0016-stability-contract.md) | Stability contract: normalized displacement, a scored [0,1] number, gated at 0.90 | Proposed | §5.4, §5.5, ADR-A3 | 4 |
| [0017](0017-worker-protocol.md) | Worker protocol: Comlink host, transferable typed arrays, cancel-preempting AbortSignal, grid crash-fallback | Proposed | §1.4, §14, ADR-0009 | 4 |
| [0018](0018-default-provider-heuristic.md) | Default provider heuristic: a pure classifier over (cut, inducedEdges) | Proposed | §5.1, §5.2, ADR-A3 | 4 |
| [0019](0019-pixi-scene-adapter.md) | Pixi v8 behind `SceneAdapter`, with a closed allowed-API surface | Accepted | §1.3, §9.1, §9.3, ADR-A8 | 5 |
| [0020](0020-label-strategy-tiers.md) | Labels: screen-space MSDF `BitmapText`, geometric tiers, bounded Unicode fallback | Accepted | §1.3, §9.3, §10.3, ADR-A8 | 5 |
| [0021](0021-spatial-index-picking.md) | Picking: worker-built world-space quadtree, synchronous CPU hit-test | Accepted | §1.3, §9.3, §10.3, ADR-A8 | 5 |
| [0022](0022-react-canvas-boundary.md) | React/canvas boundary: zustand value bridge, no draw calls from React | Accepted | §1.3, §9.1, §10.3, ADR-A8 | 5 |
| [0023](0023-transition-model.md) | Transition model: pure choreographed plans, one shared easing, 300ms/45fps hard budget, degrade-to-crossfade | Proposed | §5.4, §16.1, ADR-A3 | 6 |
| [0024](0024-anchor-rule.md) | Anchor rule: world point under cursor maps through the refinement, affine rect-to-rect, geometric fallback | Proposed | §5.4, ADR-A3 | 6 |
| [0025](0025-drill-in-vs-zoom.md) | Drill-in vs zoom: zoom moves the cut and saturates; scope changes are always explicit, both directions | Proposed | §5.4, §5.6, §10 | 6 |
| [0026](0026-resolution-depth-syntactic.md) | Resolution depth: syntactic + import-graph only, no type checker; unresolved calls omitted with counters | Accepted | §7.1–7.3, §3.1, §8.1 | 7 |
| [0027](0027-laziness-policy-thresholds.md) | Laziness policy: eager to function signatures, lazy bodies via DetailResolver; byte-identical eager/lazy IDs | Accepted | §4.7, §5.5, §7.2, §14.1 | 7 |
| [0028](0028-id-stability-under-edits.md) | ID stability under edits: (path, qualifiedName, overloadHash); whitespace edit ⇒ empty delta; rename = remove+add, alias table reserved | Accepted | §3.1, §3.2 (U4), §7.4; ADR-0002 | 7 |

Later phases extend this registry (ADR-0009+ at Phase 2, and so on). The
constitution's `ADR-A5…A12` are pre-recorded there and become numbered ADRs in
the phase that implements them.
