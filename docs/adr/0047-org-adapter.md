# ADR-0047 — `adapters/org`: organization definitions and run histories as semantic graphs

- **Status:** Accepted
- **Date:** 2026-07-29
- **Phase:** AutoBuild integration / AutoBuild roadmap Phase 14A-14B
- **Constitution:** ARCHITECTURE.md §4.3 (U1), §4.5 (U3), §20; ADR-0001, ADR-0009, ADR-0033, ADR-0034, ADR-0037
- **Integration contract:** `contracts/org-v1/`; AutoBuild `ROADMAP.md` Phase 14; AutoBuild `docs/contracts/org-definition-v1.md`, `docs/contracts/org-run-events-v1.md`
- **Numbering:** ADR-0041…0044 remain reserved by Meridian roadmap Phase 12; this integration uses the next free number

## Context

AutoBuild's Phases 11-13 made an organization a validated, digest-pinned data
artifact (`org-definition-v1`): roles, instances, teams, a workflow graph, gates,
and a brain binding. Its Phase 14 requires that a complex org be legible as a
zoomable semantic graph — org chart, responsibility matrix, run timeline — by
adapting Meridian rather than building a second renderer (AutoBuild Rule 4
applied to rendering). AutoBuild additionally exports a job's run history as a
deterministic, closed-vocabulary event document (`org-run-events-v1`) and wraps
definition + expansion attribution + runs in one adapter input
(`org-bundle-v1`).

The conversation adapter is the implementation model: deterministic, AI-free,
isomorphic, importing `@meridian/plugin-api` and nothing else of Meridian. The
plugin API is frozen at 1.0 with 1.1 additive; an org adapter must be purely
additive against `^1.0.0` and must not require api-extractor changes.

## Decision

### 1. A Tier-0 `@meridian/adapter-org` domain parser, zero AI

One package, `packages/adapters/org/`, exporting a single `manifest:
PluginManifest` with `capabilities: [{ kind: 'domain-parser', id: 'org' }]`,
`apiVersion: '^1.0.0'`, no module-scope side effects (ADR-0009). Ingest is
deterministic and AI-free: the same bundle bytes produce byte-identical
`encodeCanonical` output twice (invariant I6), and a changed definition changes
the digest. Enrichment, if it ever exists, reaches the graph as proposals from
the composition root (ADR-0034); none is in scope here.

### 2. Inputs: `org-bundle-v1` primary, bare `org-definition-v1` accepted

The adapter accepts two schema-versioned JSON documents:

- `autobuild-org-bundle-v1` — `{definition, expansion, runs}`. Team attribution
  for template-minted instances is computed by AutoBuild and carried in
  `expansion.instances[].team`; Meridian never re-implements team expansion.
- `autobuild-org-definition-v1` — structure-only ingest (no assignment or
  artifact levels).

`sniff` parses a bounded head window and claims only these two
`schema_version` strings; anything else scores 0.1 or below (the argument
adapter's deliberate under-bid), and the documented invocation is explicit:
`meridian ingest <bundle.json> --adapter org`.

### 3. Structure mapping: five nested levels

Recursion is detail graphs (ADR-0001). The ladder is
**org → team → role → assignment → artifact**:

1. `org:organization` root node — attrs include `org:id`, `org:version`,
   `org:digest`, `org:brain-store`, `org:brain-root-ref`.
2. `org:team` nodes in the organization's detail graph, one per declared team.
   Instances not owned by any team dock under a single deterministic implicit
   team node (`_direct`, label "Direct") so every branch of the tree has
   uniform depth — containment-depth-driven abstraction requires it. The
   implicit node is marked `org:implicit: true`.
3. `org:role-instance` nodes in each team's detail graph — attrs
   `org:role-type`, `org:engine`, `org:capabilities`, `org:capabilityRole`.
   `org:gate` nodes live at this level.
4. `org:assignment` nodes in the owning instance's detail graph, built from
   run events. `org:state` uses the closed vocabulary
   `not_started | in_progress | awaiting_answer | delivered | accepted |
   rejected | escalated`.
5. `org:artifact` nodes in assignment detail graphs (attrs `org:artifactKind`,
   `org:sha256`), plus discrete `org:event` nodes for point happenings
   (question answered, gate evaluated, escalation fired).

A structure-only ingest yields levels 1-3; a bundle with runs yields all five.

### 4. Temporal modeling: event and assignment **nodes**, never timestamped edges

Meridian's timeline projection reads temporal hints from node attrs only
(ADR-0037). Assignments carry `org:started-at` / `org:ended-at` (intervals);
events carry `org:started-at` alone. The manifest declares

```ts
presentation: { temporal: { startAttribute: 'org:started-at',
                            endAttribute: 'org:ended-at',
                            laneAttribute: 'org:lane' } }
```

with `org:lane` set to the owning role instance id — one swimlane per role
instance, giving run timelines with no rendering changes. All `org:*` attr
keys are declared in `attrSchemas` (U8).

### 5. Edges: same-graph only, portal rule for cross-team links

Workflow dependency edges (`required_inputs` → `produces`), review edges
(assignee → reviewer), escalation-route edges, and gate `over` edges are
emitted only between nodes of the same graph (U1). A relationship whose
endpoints live in different teams is recorded at the lowest common graph
between the endpoints' ancestors, carrying the deep endpoints as `via`
metadata — the portal rule already used by the code adapter's import
resolution. A role instance belongs to exactly one graph (U3); the workflow
"kind" vocabulary is attribute data, not node identity.

### 6. Semantic zoom: declare the level chain and wire `chainSpec` through

The manifest declares `levelChain: { domain: 'org', levels: [org, team, role,
assignment, artifact] }`. Today no composition root passes a declared chain to
the abstraction engine, so zoom levels display as `level-0…N`. This ADR
authorizes the small composition-root change: the CLI and Studio pass the
selected plugin's `levelChain` as the `chainSpec` that `NavigationController`
and `buildLevelChain` already accept. This touches no projection or renderer
code — the four view projections and the zoom machinery are unchanged — and
benefits every adapter that declares a chain (conversation included).

### 7. Vendored contract corpus with byte-parity

`contracts/org-v1/` vendors AutoBuild's schemas and golden fixtures
(org-definition, org-run-events, org-bundle) with the bridge-v1 pattern:
two-level `SHA256SUMS`, a `fixture-index.json`, a README recording the
AutoBuild source commit, and an anchor test pinning the root manifest's
SHA-256 with a drift-must-fail case. The adapter's conformance corpus
(`fixtures/corpora/org/`, with `reject/`) is exercised through
`describeParserConformance`. Corpus updates originate in AutoBuild and are
copied verbatim; Meridian never edits a vendored fixture.

## Alternatives considered

- **Ingest the expanded (teamless) org only.** Rejected: the team zoom level
  exists only in the unexpanded document; expansion attribution is carried as
  data instead.
- **Timestamped edges for the temporal graph.** Rejected: nothing reads
  temporal hints off edges; it would require new rendering work, which is the
  outcome this integration exists to avoid.
- **Variable-depth ladder (teamless instances directly under org).** Rejected:
  depth-driven abstraction would place role instances at the team level in
  mixed orgs; a deterministic implicit team preserves uniform semantics.
- **A Meridian-side org expander.** Rejected: re-implements AutoBuild's
  team-expansion semantics across a repository boundary; drift would be
  silent.
- **New view projection for org charts.** Rejected: map/outline/matrix/
  timeline plus semantic zoom already express org chart, responsibility
  matrix, and run timeline; a fifth projection is new rendering work.

## Tradeoffs and consequences

The adapter carries a vendored corpus that must be refreshed when AutoBuild's
contract evolves (additive-only within v1; the anchor hash makes drift loud).
The implicit `_direct` team introduces a node with no counterpart in the
source document; it is marked, deterministic, and documented. Wiring
`chainSpec` is a composition-root behavior change visible to other adapters:
chains they declare become live names — an improvement, but one to verify
against the conversation adapter's goldens.

## Verification required after acceptance

- Same bundle ingested twice → byte-identical canonical graph bytes; changed
  definition → different digest (conformance-kit I6).
- Every fixture in the vendored corpus: valid accepted, invalid rejected;
  root-manifest anchor hash matches; a drifted copy fails.
- Five levels render from one ingested graph with no second ingest path;
  named levels appear in Studio and the CLI after `chainSpec` wiring;
  conversation adapter goldens unchanged except level names where declared.
- No cross-graph edge in any emitted document (decode-time U1 holds); portal
  edges carry `via` endpoints.
- Timeline projection ranks non-zero for a bundle with runs and renders one
  lane per role instance; matrix/outline/map render without adapter-specific
  code.
- `depcruise` proves the adapter imports only `@meridian/plugin-api`; no
  Meridian source imports AutoBuild internals.

## Approval gate

Accepted by the user on 2026-07-29. This authorizes the additive adapter
package, the vendored `contracts/org-v1/` corpus (landed with the proposal),
and the composition-root `chainSpec` wiring exactly as specified.
