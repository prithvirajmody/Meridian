# Plugin-API 1.0 chafe report (Phase 9E)

The audit ROADMAP Phase 9 §5 mandates before the freeze: *"the phase report
must list every place the existing contract chafed; each item is either fixed
pre-freeze or explicitly deferred with rationale."* Four structurally
different domains have now been built against the contract — tree-ish
markdown (P2), dense-graph code (P7), and the two AI-native discourse domains
(9B–9D: conversation, argument) — so the roadmap's rule of three is
satisfied with one to spare. Every chafe found across those builds, plus the
two mid-flight contract changes, is dispositioned below.

Statuses: **FIXED** (resolved before the freeze, inside 1.0) ·
**DEFERRED** (kept out of 1.0 deliberately, with rationale and the additive
path that can deliver it in 1.x without a break).

## 1. Contract changes made between 0.1 and the freeze

| # | Item | Disposition |
|---|---|---|
| 1.1 | **`detail-resolver` capability (7F)** — the first post-P2 runtime-surface change: `CAPABILITY_KINDS` gained a sixth kind; `DetailResolver`/`DetailNode`/`DetailGraphRef`/`DetailContext` types added. Flagged at the time for this report. | **FIXED — frozen in.** Two consumers exist (code adapter lazy CFG/AST; P6 drill-in), the shape survived 7F–9D unchanged, and P11 hydration is designed against it. Included in 1.0 exactly as shipped (ADR-0033 open question 2 → resolved: include). |
| 1.2 | **`IncrementalAdapter` + `SourceChange` (7G)** — type-only watch-mode contract; flagged as the second post-P2 addition. | **FIXED — frozen in.** Exercised by the code adapter's incremental conformance suite; the wire shape (`update(change, sink)` emitting minimal deltas through the ordinary `IngestSink`) needed no revision across 7G–7H. |
| 1.3 | **`ProposedGroup.kind` (9C)** — the P3 rollup seam hard-coded `core:cluster` for every materialized group; the conversation domain needed manifest-typed `conv:topic` layers. Optional field added; omitted = `core:cluster`, byte-identical to every pre-9C proposal. | **FIXED — frozen in.** The rule of three at work: the generic kind was right until a second domain proved otherwise; the fix is additive and type-only. |

## 2. Chafes found while building the four domains

| # | Item | Disposition |
|---|---|---|
| 2.1 | **Wire types were unreachable from plugin-api alone (P2 toy exercise).** An author could not type their own emissions. | **FIXED in 0.1** (re-export of `GraphDocument`, `SemanticCoords`, `AttrValueType`); confirmed sufficient by all four domains — frozen as re-exported (they are the author's contract even though they originate in graph-core, ADR-0033). |
| 2.2 | **`emitDelta` is loosely typed (`DeltaWire`).** The op vocabulary belongs to graph-store; a parser streaming deltas types them loosely and the host validates. 7G watch mode lived with this comfortably (ops validated at the gate), but it remains the least-typed corner of the contract. | **DEFERRED.** Tightening would drag graph-store's op types across the §20 boundary into the frozen surface — exactly the coupling the dependency law forbids. The gate (decode + `decodeDeltaInput`) is the enforcement point and has caught every malformed delta in practice. If a real third-party author stumbles here, a *type-only* `GraphOpWire` union can be added additively in 1.x. |
| 2.3 | **U1 (intra-graph edges) vs. cross-graph references.** Conversation reply edges whose endpoints land in different exchange graphs are honestly omitted (9B); a whole-essay argument map across paragraphs is expressible only because 9D placed extracted nodes in the *paragraphs* graph. Both domains fit v1, but the pressure is real and was felt twice. | **DEFERRED — this is the §4.3 portals decision, not a plugin-api gap.** The contract itself never chafed (documents carry whatever graphs the core allows); when portals land, adapters gain expressiveness with **zero** plugin-api change, which is the correct dependency direction. Tracked for the P10+ portal ADR. |
| 2.4 | **The conformance kit's claim-your-corpus law vs. intent-driven adapters (9D).** The kit requires `sniff > 0` for every ok corpus entry, but the argument domain is a *user intent* over prose, not a detectable format. Resolved with a deliberate 0.1 under-bid (below markdown's 0.15 any-text floor). | **DEFERRED (documented pattern, no API change).** The under-bid satisfies both laws honestly: the adapter claims what it can parse while never winning an arbitration it has no evidence for. If intent-driven adapters multiply, an additive manifest hint (e.g. `arbitration: 'explicit-only'`) can formalize it in 1.x; one domain does not justify freezing that guess. The kit is **not** part of the frozen surface. |
| 2.5 | **Enrichment vocabulary has no registering manifest.** `ai:summary` (8D) is stamped by `applyProposal`, and 9C/9D enriched documents carry it — but no adapter manifest declares `ai:*`, so a strict U8 ingest gate rejects a round-tripped enriched document. Surfaced when Studio needed to open saved `.meridian` documents (9C). | **DEFERRED, with the boundary clarified.** The U8 vocabulary gate guards the *ingest* boundary (parser output → store); reopening a saved snapshot is a store round-trip and correctly decodes without a vocabulary (the Studio/CLI document paths do exactly this). Host-level registration of gateway-owned vocabulary (`ai:*`) is a plugin-**host** concern and can arrive additively; it must not widen plugin-api (ADR-0034: the seam does not grow because AI exists). |
| 2.6 | **ADR-0034's open materializer question** — where "validate proposal → atomic delta" plumbing lives. 9C and 9D each have a pass in the composition root (`apps/cli/src/enrich.ts`); the shapes rhyme but were not factored. | **DEFERRED.** Two consumers exist but share a file, not an API; factoring now would invent an internal library with no second *caller*. Decisive constraint: the materializer must never enter plugin-api (no store references behind the seam — ADR-0033/0034), so deferring costs no freeze surface. Revisit when a third pass (9x research-papers or P12 agents) exists. |
| 2.7 | **`PluginContext.apiVersion` is a bare string.** Every context stub in tests hand-writes it; nothing ever branched on it across four domains. | **DEFERRED (kept as-is in 1.0).** It is the honest minimum: hosts advertise, plugins may branch if they ever need to. Removing it would be breaking; structuring it (parsed semver) is additive later if a use appears. |
| 2.8 | **Manifest `apiVersion` caret-0.x migration.** Under ADR-0010 range rules, `^0.2.0` excludes 1.0, so every 0.2 manifest stops activating against a 1.0 host — by design, not accident. | **FIXED — migration executed.** All four first-party manifests (and the toy-adapter exercise) now declare `^1.0.0`; each passed conformance before the change was committed. Migration notes are folded into ADR-0033. |

## 3. What the freeze mechanically is

- `PLUGIN_API_VERSION = '1.0.0'`; package `@meridian/plugin-api@1.0.0`.
- The frozen surface is the committed api-extractor report
  `packages/plugin-api/etc/plugin-api.api.md`. The package's `test` script
  runs `api-extractor run` in verify mode, so **any surface drift fails CI**;
  intentional changes regenerate via `pnpm api:update` (the documented regen
  command — never by hand) plus a CHANGELOG entry and compatibility review.
- Evolution policy: additive-only until 2.0 (ADR-0033 — new exports, new
  capability kinds, new optional fields; deprecations marked and never
  removed before 2.0).

## 4. Verdict

No chafe found in four domains required reshaping the frozen surface; the
three contract changes since 0.1 (1.1–1.3) were all additive and are all
carried into 1.0. The deferred items (2.2–2.7) each have an additive 1.x
path and none blocks a third-party author today. The contract is ready to
seal; the M3 review accepts ADR-0033/ADR-0010 and cuts the `plugin-api@1.0`
tag.
