# Meridian — Opus-scale subphase plan (Phases 3–12)

**Purpose.** [ROADMAP.md](ROADMAP.md) phases are milestone-sized; several are
too large for a single Claude Opus 4.8 session to carry without losing the
plot. This document slices each remaining phase's **build beat** (see
[DRIVING-OPUS.md](DRIVING-OPUS.md) §2) into subphases sized for one focused
Opus session each. It changes **nothing** about scope, verification tables,
ADRs, or Definitions of Done — the roadmap remains the contract; this is the
session schedule for fulfilling it.

**Status when written (2026-07-05).** Phase 0 committed (`cde7733`).
Phases 1–2 are built in the working tree (ADR-0005…0011, `graph-store`,
`plugin-api`/`plugin-host`/`conformance-kit`, `adapters/markdown`, checklists
and demos for both) but **uncommitted** — see subphase 2Z below.

**Build progress (updated 2026-07-11).** Committed & tagged through
**Phase 4** (`phase-4`): 4A `f2b5f77`, 4B `9c845b2`, 4C `5d2897a`,
4D `58298db`, 4E gate. The two human-judgment rows of the Phase 4 table
(SVG quality review; pathology eyeball) are marked UNVERIFIED — HUMAN in
`docs/checklists/phase-04.md`, pending user review alongside M1.
Status legend: ✅ done (committed/tagged) · 🔨 in progress (uncommitted) ·
⬜ not started.

| Phase | Subphases done | Frontier |
|---|---|---|
| 0 | ✅ committed `cde7733` | closed |
| 1–2 | ✅ `2Z` — tags `phase-1`, `phase-2` | closed |
| 3 | ✅ `3A`–`3E` — tag `phase-3` (M1 closed) | closed |
| 4 | ✅ `4A`–`4E` — tag `phase-4` | closed (human SVG review pending) |
| 5 | ✅ `5A`–`5F` built | human row + `phase-5` tag pending |
| 6 | ✅ `6A`–`6E` built | M2 review + human rows + tag pending |
| 7 | ✅ `7A`–`7H` — gate walked, tag `phase-7` awaits user | closing (domain track) |
| 8–12 | ⬜ not started | — |

---

## How to run a subphase

Every subphase is one session. The rules, in order:

1. **One subphase per session.** Paste the whole subphase spec (plus the
   roadmap section references it names) into the kickoff prompt. Don't
   drip-feed.
2. **Each subphase ends green.** Its exit criteria pass, the *entire*
   accumulated suite passes, and you commit. A subphase that ends with
   red tests is not done — it carries into a fresh session that starts by
   reading the failure output.
3. **ADR subphases (`*A`) always come first** and end with a stop for your
   approval. No build subphase starts until its phase's ADRs are merged.
4. **The last subphase of each phase is the gate** — verification table row
   by row with real output, demo, DoD checklist, tag `phase-N`. You close it,
   not the model (DRIVING-OPUS.md §4).
5. **Sizing rule of thumb** used throughout: one subphase ≈ one package, or
   one coherent algorithm + its property tests, or one integration surface.
   If a session is going long, the correct cut point is "current exit
   criteria green, commit, new session" — never "skip the tests."

Kickoff prompt template (adapted from DRIVING-OPUS.md §2; refined after the
Phase 3 supervised run, where this shape went 5-for-5 with zero rework):

> We are in Phase N of docs/ROADMAP.md, subphase NX of docs/SUBPHASES.md.
> Read CLAUDE.md, docs/SUBPHASES.md §NX, the roadmap sections it names, and
> the phase's ADRs — **the current text; ADRs may have been amended by
> earlier subphases**. Prior subphases are committed: read the existing
> package src/ first and build on it — do not duplicate its machinery. For
> a new package, copy the build/test/tsconfig conventions of \<model
> package\>. Implement exactly this subphase's deliverables. Do NOT build
> \<named items from the next subphase\>. Write the listed tests as you
> go, not after. Exit criteria you must demonstrate with real output:
> \<the subphase's exit list, plus\> full monorepo suite green from the
> root — report the actual output tail. Final report: outcome first with
> real numbers, then files created/modified, then any deviation from the
> ADRs/spec and why — flag anything that should be folded back into an ADR.

Two more rules learned from the Phase 3 run:

6. **ADRs drift during build — fold amendments back.** Twice in Phase 3 the
   builder found a genuine gap in a merged ADR (an undefined endpoint case;
   an off-by-one in the hysteresis subscripts). The builder's job is to
   implement the defensible reading and *flag it*; the supervisor's job is
   to amend the ADR text in the same commit. The ADR stays authoritative —
   semantics must never live only in code comments.
7. **Session dies mid-subphase → resume, don't restart.** Resume the same
   session/agent with "pick up where you left off", a list of what the
   working tree already holds, and the remaining deliverables. The Phase 3E
   session was cut mid-run and finished cleanly this way; the tree (not the
   conversation) is the ground truth it re-syncs against.

Parallel tracks: after 3E (M1), the visual track (Phases 4→5→6) and the
domain track (Phase 7) are independent — you can alternate sessions between
them or run them in separate worktrees. Phase 8 needs only Phase 7's output.

---

## Phase 2 close-out

### 2Z — Gate and commit Phases 1–2  ✅ DONE (tags `phase-1`, `phase-2`)
The P1/P2 work in the tree has never been through a gate beat. Walk the
Phase 1 and Phase 2 verification tables row by row, run every harness, check
both DoD checklists literally, then commit and tag `phase-1` + `phase-2`.
- **Exit:** full suite green from a clean `pnpm i`; both phase checklists
  checked; working tree clean; tags pushed.
- **Roadmap refs:** Phase 1 §12–13, Phase 2 §12–13.

---

## Phase 3 — Abstraction levels & semantic LOD (closes M1)  ✅ DONE (tag `phase-3`)

The intellectual heart of the product, and pure headless computation — it
splits cleanly along its three algorithms. Roadmap refs: Phase 3 §1–13.

### 3A — ADR beat  ✅ DONE (`f7ee713`)
Draft ADR-0012 (zoom semantics), ADR-0013 (induced-edge aggregation),
ADR-0014 (node budget + salience v1). Stop for approval.
- **Exit:** three ADR drafts in `docs/adr/`; no code written.

### 3B — Level chains & cuts  ✅ DONE (`5802d21`)
`@meridian/abstraction` package skeleton; `LevelChainSpec` + `buildLevelChain`
(per-domain named levels, contributed via adapter manifests); `Cut`
construction with covering proof; the `AbstractionProvider` capability enum
entry goes live in `plugin-api` (types only).
- **Tests:** fast-check I5 (cut coverage) on random forests; ragged-hierarchy
  and orphan fixtures; empty/single-node graphs.
- **Exit:** I5 property suite green; markdown corpus gets a working default
  level chain with zero adapter changes.

### 3C — Induced-edge aggregation  ✅ DONE (`8c86a06`)
`aggregateEdges(space, cut)` per ADR-0013: grouping key, weight function,
cap-with-"+n more", `samples`; incremental cache invalidated via P1
`ChangeSet`s.
- **Tests:** induced-edges-vs-bruteforce equivalence on random graphs;
  cache invalidation touches only affected ancestors (op-count asserted);
  benchmark: resolve on 100k-node/8-level synthetic forest <30ms warm /
  <150ms cold (this is the phase's perf cliff — gate it now).
- **Exit:** equivalence property green; benchmark thresholds in
  `benchmarks/budgets.json` and passing.

### 3D — LOD resolver & deterministic providers  ✅ DONE (`2e099c5`)
`LodResolver.resolve(req)` as a pure function: `ZoomPolicy`
(scalar→cut with hysteresis, ADR-0012), per-node pin/expand/collapse
overrides, node budget with salience degradation (ADR-0014), `CutTrace`
provenance. Deterministic `AbstractionProvider`s: containment rollup;
degree/size-based collapse for flat graphs. `applyProposal(store, proposal)`
— proposals become ordinary P1 deltas.
- **Tests:** override interaction matrix (pin inside collapsed ancestor,
  etc.); zoom↔level mapping incl. hysteresis; determinism by result-hashing;
  1M-leaves-under-one-parent budget kick-in; overrides referencing removed
  nodes.
- **Exit:** resolver deterministic (hash-verified); all failure fixtures
  handled with located errors.

### 3E — CLI, goldens, M1 gate  ✅ DONE (`99d53e6`, tag `phase-3`, M1 closed)
`meridian cut --level N | --zoom 0.42 --focus <id>`; goldens across the
markdown corpus at every level; proposals applied through the real store;
manual walk of a real book judging each cut. Then the full Phase 3
verification table, the M1 demo script (`docs/demos/m1.md`,
all-CLI ingest→mutate→cut), DoD, tag `phase-3`.
- **Exit:** phase gate closed by you; **M1 review held**. Parallel tracks
  may now start.

---

## Phase 4 — Layout engine  ✅ DONE (tag `phase-4`; human SVG review pending)

Split by provider risk: harness first with trivial providers, then workers,
then the two real engines one at a time. Roadmap refs: Phase 4 §1–13.

### 4A — ADR beat  ✅ DONE (`f2b5f77`)
Draft ADR-0015 (coordinates/units), ADR-0016 (stability contract), ADR-0017
(worker protocol), ADR-0018 (default provider heuristic). Stop for approval.

### 4B — Package, trivial providers, SVG harness  ✅ DONE
`@meridian/layout`: `LayoutProvider` interface, `grid` and `tree`
deterministic providers (main-thread for now), `LayoutInput/LayoutResult`
types, SVG snapshot exporter, CLI `meridian layout --svg out.svg`,
`layout-provider` capability in plugin-api.
- **Tests:** providers on tiny graphs vs hand-computed truth; SVG goldens
  (normalized before diff) for grid/tree over the corpus; zero-size nodes;
  disconnected components.
- **Exit:** golden-SVG pipeline works end-to-end on real P3 cuts — the
  review harness exists before any hard engine does.

### 4C — Worker host, cancellation, cache  ✅ DONE
Comlink worker host (transferable typed arrays per ADR-0017); cancellation
(new request aborts stale one — measured, not assumed); `LayoutCache` keyed
`(storeVersion, cutHash, providerId, hintsHash)`; provider-crash recovery
with fallback to grid.
- **Tests:** cancellation actually stops compute; cache hit <1ms;
  cancellation storm; worker crash → host recovers; main thread never
  blocked >4ms.
- **Exit:** grid/tree run inside the worker with identical goldens; this is
  the worker infrastructure P5 picking and P7 parsing will reuse.

### 4D — elk-layered (compound) provider  ✅ DONE
elkjs provider with compound nodes (nested graphs), position hints for the
ADR-0016 stability contract, stability scorer, optional orthogonal routes.
- **Tests:** SVG goldens per corpus; stability score ≥ threshold on scripted
  small-delta sequences; benchmarks: 2k-node compound cut <1.5s worker-side;
  incremental re-layout after 10-node delta <100ms.
- **Exit:** elk goldens locked; stability is a scored, CI-gated number.

### 4E — d3-force provider, heuristic, phase gate  ✅ DONE
Seeded deterministic force provider with warm-start from previous result;
ADR-0018 default-provider heuristic (layered for DAG-ish, force for
cluster-ish); then the full verification table, human SVG review against the
checklist, ugliest-fixture pathology notes, DoD, tag `phase-4`.
- **Tests:** force determinism (seeded) is a test; 10k nodes to convergence
  <3s; full regression.
- **Exit:** phase gate closed; layout quality judgeable from CI artifacts
  alone.

---

## Phase 5 — Renderer & app shell (first pixels)

The biggest phase in the plan — six sessions. The seam order matters:
pure view-model first, then scene, then labels/picking, then the app, then
the Playwright gate. Roadmap refs: Phase 5 §1–13.

### 5A — ADR beat  ✅ DONE
Draft ADR-0019 (pixi behind SceneAdapter + allowed-API list), ADR-0020
(label strategy/tiers), ADR-0021 (picking), ADR-0022 (React/canvas
boundary). Stop for approval.

### 5B — view-model (pure, headless)  ✅ DONE
`@meridian/view-model`: `buildRenderModel(snapshot, lodResult, layoutResult,
selection) → RenderModel` — flat typed-array-friendly arrays, no pixi, no
DOM. Also `CameraState` math and the label-tier function (pure, per
ADR-0020) live here or adjacent — everything unit-testable without a GPU.
- **Tests:** buildRenderModel on hand-built inputs; camera math; label tier
  function; NaN-position clamping (hostile layout input → clamped + warned).
- **Exit:** RenderModel fully specified and tested with zero browser deps.

### 5C — Scene core: quads, edges, culling, camera  ✅ DONE (`895bf61`)
`@meridian/renderer`: `SceneAdapter` over pixi v8 — instanced node quads,
edge lines, quadtree viewport culling, geometric `CameraController`
(pan/zoomAt), renderer stats counter (draw calls, culled count).
- **Tests:** quadtree unit tests; culling assertion via stats (draw calls
  drop as you zoom in); WebGL context loss auto-restore; zero-node graph.
- **Exit:** a fixture renders in a bare HTML harness page; culling
  provably active.

### 5D — Labels & picking  ✅ DONE (`6762ca5`)
Zoom-tiered BitmapText/SDF labels (ADR-0020); picking per ADR-0021
(quadtree hit-test favored); hover/selection event streams.
- **Tests:** tier transitions at scripted zoom levels; pick accuracy at
  boundaries and hi-DPI; hover→select round-trip <16ms.
- **Exit:** 10k-node fixture with labels still hits the frame budget in a
  local FPS probe (formal CI gate lands in 5F).

### 5E — Meridian Studio shell  ✅ DONE (`5cadf10`)
`apps/studio`: Vite + React + zustand chrome — file open, adapter pick via
sniff, canvas island receiving the view-model (ADR-0022 boundary), side
panel with selected node's attrs + provenance, FPS/heap HUD behind a debug
flag. Full pipeline wired: ingest → cut → layout → render.
- **Tests:** zustand store logic; React components import no pixi
  (depcruise); renderer imports no graph-store (only view-model output).
- **Exit:** `pnpm dev` opens any corpus file end-to-end by hand.

### 5F — Playwright infra & phase gate  ✅ DONE (gate commit; human row + `phase-5` tag pending — checklists/phase-05.md)
Playwright: screenshot baselines per corpus at 3 zoom scales
(software-rendering CI profile, tolerance-banded diffs, deterministic
camera scripts), interaction scripts (hover label, click select, panel
populates), automated FPS sampler (p95 frame time ≤18ms during scripted
pan/zoom on the 10k fixture), 5-min heap soak. Then verification table,
manual exploratory (trackpad/hi-DPI/resize), DoD, demo recording, tag
`phase-5`.
- **Exit:** phase gate closed; the FPS test is a permanent CI gate.

---

## Phase 6 — Semantic zoom & navigation (closes M2)

Pure planners first (testable feel), then the controller, then Studio
choreography, then the human tuning gate. Roadmap refs: Phase 6 §1–13.

### 6A — ADR beat  ✅ DONE (`5f1b4f2`; ADRs accepted `b8c4fb9`)
Draft ADR-0023 (transition model + 300ms/45fps budget), ADR-0024 (anchor
rule), ADR-0025 (drill-in vs zoom). Stop for approval.

### 6B — Cut-diff & TransitionChoreographer (pure)  ✅ DONE (`4806a15`)
`@meridian/navigation`: `RefinementMap` derivation from containment;
cut-diff → enter/exit/move sets; `TransitionChoreographer.plan()` producing
inspectable `TransitionPlan`s; anchor-preservation math (ADR-0024) as a
pure function; degrade-to-crossfade rule (ADR-0023).
- **Tests:** plans for hand-built cut diffs; anchor math property (point
  under cursor maps through refinement); plan computation <20ms on 5k-node
  cut diffs.
- **Exit:** feel bugs are now inspectable data structures — before any
  animation runs.

### 6C — NavigationController & URL state  ✅ DONE (`e51cd9f`)
Zoom scalar ↔ `LodRequest` with the hysteresis state machine; override map
(expand/collapse-in-place); drill-in/out context stack (`NavContext`);
URL state codec (`#g=…&z=…&focus=…`); search over the P1 label-token index
with fly-to targeting; keyboard navigation model.
- **Tests:** hysteresis state machine (oscillating input at a threshold →
  zero cut-flaps); breadcrumb truthfulness property (context stack ≡ replay
  of nav events); URL round-trip restores exact view; drill into node with
  no detail.
- **Exit:** controller fully tested headless against the real resolver.

### 6D — Studio choreography  ✅ DONE (5F 10k FPS row: environmental fail on loaded host — re-verify idle)
Wire controller + choreographer into Studio/renderer: animated transitions
(shared easing, retarget-not-queue on zoom-during-flight), breadcrumb bar,
search box, minimap, expand/collapse in place, store-mutation-mid-transition
replan (P1 subscription).
- **Tests:** Playwright scripted descents/ascents on 3 corpora;
  mid-transition screenshot baselines (deterministic clock injected);
  transition p95 frame time ≤22ms; anchor pixel drift <8px per transition.
- **Exit:** the book descent runs scripted, within budgets, anchor held.

### 6E — Tuning & M2 gate  ✅ BUILT (human rows + M2 review + `phase-6` tag pending — checklists/phase-06.md)
Debug panel with tunable constants; manual tuning sessions (this is the
human gate — DRIVING-OPUS.md §4); the "grandmother test"; constants frozen
into defaults; full verification table, recorded demo, `docs/demos/m2.md`,
DoD, tag `phase-6`.
- **Exit:** **M2 review held**; you sign off on feel personally.

---

## Phase 7 — Source-code domain adapter (parallel track)

Eight sessions — the most subphases of any phase, because each language
construct family and each pipeline stage is separately testable. Runs
headless; interleave with Phases 4–6 freely after 3E. Roadmap refs:
Phase 7 §1–13.

### 7A — ADR beat  ✅ DONE
Draft ADR-0026 (resolution depth: syntactic only), ADR-0027 (laziness
policy + thresholds), ADR-0028 (ID stability under edits). Stop for
approval.

### 7B — tree-sitter shim & grammars  ✅ DONE
One grammar-loading shim (Node + browser, worker-hosted, reusing 4C's
worker infra), WASM grammars for TypeScript + Python vendored under the
package; parse smoke tests; error-tolerant parse of syntax-error files
yields partial trees.
- **Tests:** shim loads both grammars in Node and (headless) browser;
  grammar load failure → useful error; syntax-error file → partial parse
  flagged.
- **Exit:** parsing works everywhere the app runs; nothing graph-shaped yet.

### 7C — TypeScript mapping: eager levels  ✅ DONE
`adapters/code`: mapping rules for project → package → module →
class/function (signatures) for TypeScript; stable IDs per ADR-0002/0028
from `(path, qualifiedName, overloadHash)`; provenance spans; conformance
suite passes.
- **Tests:** per-construct mapping rules (each language feature → expected
  nodes/edges); ID stability functions; byte-determinism across runs;
  conformance kit.
- **Exit:** `meridian ingest ./ts-fixture --adapter code` produces a valid,
  deterministic graph at eager levels.

### 7D — Python mapping: eager levels  ✅ DONE
Same shape as 7C for Python (module/class/function granularity per the
level-chain spec).
- **Exit:** both languages green on conformance; shared mapping machinery
  factored only where it actually repeats (no speculative abstraction).

### 7E — Import graph & call graph  ✅ DONE
`code:imports` edges (module level) and syntactic `code:calls`
(same-file/same-module resolution, explicitly not type-aware, per
ADR-0026); edges carry `confidence: 'syntactic'`.
- **Tests:** hand-drawn truth for import/call fixtures in both languages;
  cross-module unresolved calls handled honestly.
- **Exit:** module-level induced edges over the fixture repo look sane in
  `meridian cut` output.

### 7F — CFG & lazy AST (DetailResolver)  ✅ DONE (`8b34a4e`)
`DetailResolver` capability added to `plugin-api` (minor version — first
post-P2 contract change, note it for the P9 chafe report); CFG builder for
function bodies; AST subgraphs materialized lazily on drill-in per
ADR-0027.
- **Tests:** CFG vs hand-drawn truth for tricky control flow (early
  returns, try/finally, loops with breaks, match/switch); lazy resolve
  <150ms; laziness thresholds respected.
- **Exit:** drill into any function in the fixture repo materializes
  CFG/AST on demand.

### 7G — Incremental: watch mode & minimal deltas  ✅ DONE (`b55c405`)
`IncrementalAdapter.update(SourceChange, sink)`: file change → incremental
re-parse → minimal `GraphDelta`; `meridian watch ./repo`; the *incremental*
conformance suite (edit scripts with expected minimal deltas).
- **Tests:** whitespace-only edit → **empty** delta (the flagship test);
  single-function edit → delta touching only that function's subtree
  (asserted op-count); rename = remove+add per ADR-0028; edit → applied
  delta <100ms p95.
- **Exit:** incremental conformance green on both languages.

### 7H — Scale, dogfood, phase gate  ✅ DONE (`111131f`; human dogfood row + tag `phase-7` await user — checklists/phase-07.md)
Pinned real OSS repo (~100k LOC) fixture: cold ingest <30s,
byte-deterministic; include/exclude globs, laziness budget policy (10MB
generated file excluded), symlink cycles; **dogfood: load Meridian's own
monorepo and judge every level**. Full verification table, repo goldens
pinned to a fixture commit hash, DoD, tag `phase-7`. (The Playwright
zoom-the-repo row lands here if P6 is done, else it's queued into the M2+P7
combined demo.)
- **Exit:** phase gate closed; Meridian renders Meridian.

---

## Phase 8 — AI reasoning layer

Gateway before providers, providers before services, services before evals.
Everything must run green with zero network before any live call exists.
Roadmap refs: Phase 8 §1–13.

### 8A — ADR beat
Draft ADR-0029 (provider/models/structured outputs), ADR-0030 (record/replay
determinism), ADR-0031 (trust & provenance), ADR-0032 (budget policy). Stop
for approval.

### 8B — Gateway core with MockProvider
`@meridian/ai`: `AiProvider` interface + `ai-provider` plugin capability;
`MockProvider`; `AiSession.call<T>` pipeline (cache → budget → provider →
zod validate, one repair attempt → reject); content-hash response cache
(durable — doubles as the record/replay fixture store); `BudgetGuard`
(ceilings, hard-stop semantics per ADR-0032); `PromptSpec` — prompts are
versioned files, never string literals.
- **Tests:** cache keying (promptVersion + inputHash); BudgetGuard state
  machine; zod rejection paths; PromptSpec rendering; budget trip mid-run
  leaves valid partial state. All against MockProvider — zero network.
- **Exit:** the entire AI discipline exists and is tested before the first
  real API call.

### 8C — Anthropic provider & record/replay
Anthropic implementation (`claude-opus-4-8` extraction/summarization,
`claude-haiku-4-5` bulk labels; structured outputs via
`output_config.format` + zod; prompt caching for shared graph-context
prefix; Batches path for corpus jobs); 429/529 backoff; refusal
stop-reason handling; record mode (local/nightly) vs replay mode (CI —
cache miss is a test failure, per ADR-0030). Env-based key config.
- **Tests:** record a small fixture set live (needs your key — human step),
  then prove CI green with network disabled; failure-mode suite (429,
  refusal, schema-invalid → repair → reject, network loss mid-batch).
- **Exit:** CI runs all AI paths with zero network, proven by running with
  network disabled.

### 8D — SummarizingAbstractionProvider
First real service: names + summaries for rollup nodes, implementing the
existing P3 `AbstractionProvider` seam; emits `AbstractionProposal`s →
ordinary tagged deltas (`origin:'ai'`, model, promptVersion, inputHash,
confidence); CLI `meridian ai summarize --budget 2.00`; recorded fixtures
over the P7 repo.
- **Tests:** replay end-to-end over the fixture repo; proposals → store →
  cut pipeline; provenance populated and filterable; replay overhead
  <5ms/call.
- **Exit:** the P7 repo's module cut carries AI summaries in replay mode.

### 8E — Clusterer & StructureExtractor
Pluggable embedding provider (vectors only); `EmbeddingClusterer` (flat
node soup → labeled groups); `StructureExtractor` (text → `GraphProposal`
— the P9 enabler); CLI `meridian ai cluster`.
- **Tests:** clusterer on the 500-node soup fixture (recorded); embedding +
  clustering of 5k nodes <10s live-nightly; extractor output validates
  against schema with malformed-output fuzz.
- **Exit:** all three services green in replay.

### 8F — Evals, Studio surface, phase gate
`evals/`: offline harness, human-rated golden sets with rubric, floors for
regression-gating (not every CI run). Studio: AI-origin nodes visually
distinct, filter toggle, accept/reject proposal flow (auto-accept opt-in
per ADR-0031). Read 20 module summaries against real code and rate them.
Cost table (¢/1k nodes, measured) committed. Full verification table, DoD,
tag `phase-8`.
- **Exit:** phase gate closed; anyone with a key can run the evals from
  docs.

---

## Phase 9 — Conversations & arguments (closes M3)

One adapter per pair of sessions, then the freeze — the freeze is its own
session because it's an audit, not a build. Roadmap refs: Phase 9 §1–13.

### 9A — ADR beat
Draft ADR-0034 (hybrid adapter pattern: deterministic skeleton + cacheable
AI enrichment passes). ADR-0033 (1.0 scope) is *drafted* now but finalized
in 9E after the chafe report. Stop for approval.

### 9B — Conversation adapter: skeleton
`adapters/conversation`: per-format parsers (Claude JSON, ChatGPT JSON —
tiny, isolated, own fixtures) → deterministic message/thread/exchange
skeleton; level-chain spec registered via manifest; conformance.
- **Tests:** format-parser fixtures incl. truncated/hand-edited exports;
  one-message conversation; 1k-message skeleton ingest <3s; conformance.
- **Exit:** conversations ingest and zoom (levels: session → exchange →
  message) with zero AI — the degraded mode is the foundation, per
  ADR-0034.

### 9C — Conversation adapter: AI enrichment
Topic/claim layering via 8D/8E services as a separate cacheable pass;
idempotent merge (re-run must not duplicate nodes — keyed by inputHash);
recorded fixtures; goldens.
- **Tests:** enrichment idempotency; AI-unavailable → degraded-but-working
  skeleton (explicit test); full ingest→zoom goldens in replay.
- **Exit:** a real exported conversation zooms topics→messages with AI
  topic labels in Studio.

### 9D — Argument adapter
`adapters/argument`: deterministic paragraph/sentence fallback skeleton;
`StructureExtractor`-driven claims/premises/objections with typed
`arg:supports|rebuts|assumes|cites` edges; eval fixture: argument map of a
known essay judged against a human-made reference map.
- **Tests:** conformance; skeleton-only mode; extraction eval floor;
  recorded goldens.
- **Exit:** both AI-native domains pass conformance and zoom in Studio.

### 9E — Chafe report, 1.0 freeze, M3 gate
The audit session: write the **chafe report** (every place the plugin
contract chafed across markdown/code/conversation/argument — including 7F's
DetailResolver addition); fix or explicitly defer each item; finalize
ADR-0033; freeze `plugin-api` 1.0 (api-extractor snapshot becomes a CI
contract); plugin author guide v1; re-run the toy-adapter exercise against
1.0 docs with a fresh person (<1 hour — human step). Full verification
table, three-domain demo recorded, `docs/demos/m3.md`, DoD, tag `phase-9`
and `plugin-api@1.0`.
- **Exit:** **M3 review held**; the external API is frozen.

---

## Phase 10 — View projections

The dangerous subphase is the refactor (10B) — it's gated on byte-identical
map goldens, so it gets a session to itself. Each new projection is then an
independent, parallelizable session. Roadmap refs: Phase 10 §1–13.

### 10A — ADR beat
Draft ADR-0035 (what survives a mode switch), ADR-0036 (projections own
their medium behind ProjectionHost). Stop for approval.

### 10B — Extraction refactor: MapProjection
Formalize `Selection`/`Focus` (implicit in zustand until now);
`@meridian/projections` with `ViewProjection`/`ProjectionInstance`/
`ProjectionHost`; refactor the P5/P6 map into `MapProjection`,
behavior-identical.
- **Tests:** THE gate — the entire existing P5/P6 golden + FPS suite passes
  unchanged; map screenshot goldens byte-identical post-refactor.
- **Exit:** map is a projection; nothing observable changed.

### 10C — OutlineProjection
Virtualized DOM tree (second medium — proves view-model neutrality);
keyboard navigation; layout becomes optional input to `ProjectionModel`.
- **Tests:** virtualization windowing; 100k rows at 60fps scroll; keyboard
  nav; selection applied/read back.
- **Exit:** outline works on all three domains.

### 10D — MatrixProjection
Canvas adjacency matrix, cluster-ordered.
- **Tests:** ordering unit tests; 2k×2k render <500ms; selection mapping.
- **Exit:** matrix works where meaningful, degrades with a message where
  not.

### 10E — TimelineProjection
Timeline/swimlane for domains with temporal attrs (conversations first);
`suitability()` drives the mode menu; atemporal domains degrade with a
message, never crash.
- **Exit:** timeline on conversations; graceful refusal elsewhere.

### 10F — Mode switcher & phase gate
Studio switcher; per-projection view-state persistence; ADR-0035 survival
rules wired (selection+focus always; camera map↔map; scroll→focus-node
visibility). Property test over random switch sequences; the 4×3
mode-switch Playwright matrix; switch <200ms; switch-mid-transition;
projection-throws-on-mount → host falls back to map. Verification table,
projection-author guide section, DoD, tag `phase-10`.
- **Exit:** phase gate closed; `view-projection` capability is public API.

---

## Phase 11 — Scale, persistence & hardening

Backend first in Node where debugging is sane, then hydration semantics,
then the browser port, then the two big integration wires, then the
benchmark gate. Roadmap refs: Phase 11 §1–13.

### 11A — ADR beat
Draft ADR-0037 (SQLite embedded store, OPFS strategy, single-writer),
ADR-0038 (hydration & eviction policy). ADR-0039 (WASM go/no-go) is
*decided in 11G from measured data* — draft only its criteria now. Stop
for approval.

### 11B — StorageBackend & store-sqlite (Node)
`StorageBackend` constructor param on `GraphStore` (interface otherwise
unchanged — api-extractor proves it); `@meridian/store-sqlite` on
better-sqlite3: versioned schema (graphs/nodes/edges/ops-log/indices),
migrations per ADR-0004, durable op-log append (the P12 substrate);
`meridian open <project.meridian-db>`.
- **Tests:** backend CRUD + migration; full golden corpus passes against
  the sqlite backend; kill -9 during write → reopen recovers via op-log
  replay; corrupted db detected, refuses with message, offers export.
- **Exit:** Node persistence round-trips everything; crash recovery proven.

### 11C — Lazy hydration & eviction
Per-graph hydration states (`cold|hydrating|live|evictable`) reusing the
`DetailResolver` pattern from 7F; memory budgets; eviction of
hydrated-but-unviewed subgraphs per ADR-0038; interaction with undo
history.
- **Tests:** hydration state machine; eviction vs undo; drill-in triggers
  load; memory ceiling under soak.
- **Exit:** cold-open a big db → first interactive cut without full
  hydration.

### 11D — Browser backend (wa-sqlite/OPFS)
OPFS-backed browser build; parity suite (browser and Node run the same
scenarios); OPFS-unavailable → clean fallback to in-memory + document
export (persistence is an enhancement, not a correctness requirement).
- **Exit:** parity suite green in both runtimes; fallback tested.

### 11E — Streaming ingestion
Adapters already emit deltas — the store now applies them in
bounded-memory batches with progress; progress UI in Studio; disk-full
handling.
- **Tests:** the pinned ~1M-LOC monorepo ingests streamed with bounded
  memory (heap-asserted); UI responsive during background ingest
  (Playwright).
- **Exit:** the monorepo fixture ingests on reference hardware without
  memory blowup.

### 11F — Incremental pipeline end-to-end
Wire and measure ChangeSet → affected-cut diff → layout patch → render
patch; edit-storm coalescing (100 edits/s).
- **Tests:** file edit propagates to pixels <1s p95; convergence property —
  any interleaving of rapid edits converges to the from-scratch result
  (I6 extended).
- **Exit:** the "edit a file, watch the map update" demo works live.

### 11G — Benchmark dashboard & phase gate
`benchmarks/` promoted: dashboard artifact per CI run; every promise in
`budgets.json` green (500k stored / 50k working set / cold open <3s /
edit→pixel <1s p95); pinned runner class + relative-regression gating
(±15%); profiling docs; **ADR-0039 decided from this phase's numbers**;
full-matrix regression (highest-regression-risk phase — everything, both
backends). DoD, tag `phase-11`.
- **Exit:** phase gate closed; every performance promise is a CI gate.

---

## Phase 12 — Collaboration & platform (closes M4)

Two independent halves — sync (12B–12E) and plugin platform (12F) — which
can interleave. The convergence simulator is the flagship deliverable and
gets its own session. Roadmap refs: Phase 12 §1–13.

### 12A — ADR beat
Draft ADR-0040 (sync model — revisit op-log vs CRDT against real
requirements; document the offline consequence), ADR-0041 (conflict
policy), ADR-0042 (plugin trust model), ADR-0043 (SDK docs/versioning).
Stop for approval.

### 12B — sync-protocol
Wire types (hello/subscribe/ops/ack/presence), versioned `SyncMsg` union,
shared client↔server with zero server-only deps leaking clientward.
- **Tests:** codec fuzz; version negotiation; duplicate-delivery
  idempotency semantics specified at the type level.
- **Exit:** the protocol exists as a tested, dependency-clean package.

### 12C — Sync server
`services/sync`: Node + WebSocket per-session op sequencer over the P11
durable log; presence fan-out (throttled, interest-scoped); auth left as a
documented hook; containerized with a deployment recipe.
- **Tests:** sequencer ordering; 1k ops/s/doc sustained; server death
  mid-session; clock skew; duplicate op delivery.
- **Exit:** the first server-side deployable runs and sequences.

### 12D — Client SyncEngine & convergence simulator
`SyncEngine` wrapping GraphStore: optimistic local apply → server rebase
(tractable because ops carry `prev` and the server orders); offline =
read-only + queued ops that rebase on reconnect (ADR-0040); **the
multi-client convergence simulator** — N simulated clients × random op
streams × random partitions must converge with zero divergence
(10k-op fuzz runs).
- **Tests:** rebase transform per op pair; the simulator (flagship);
  disconnect/reconnect with queued local ops.
- **Exit:** convergence fuzz green — the P1 bet formally pays off.

### 12E — Presence & live-session UI
Studio presence layer: avatars, live cursors mapped through each peer's
projection, camera-follow mode, conflict toasts (attr LWW + retained
history per ADR-0041).
- **Tests:** two-browser-context Playwright live session; presence
  <250ms p95 LAN; 10-peer presence at 60fps client-side; screenshot
  goldens.
- **Exit:** two browsers, one graph, live — the M4 demo's first half.

### 12F — Plugin platform
Registry manifest schema (+ signature verification); `meridian plugins add
<tarball|url>` with signature + conformance-run gate; worker-based plugin
isolation (the ADR-0009 payoff — plugins get a capability object, never a
direct store reference); permission declarations enforced (ADR-0042);
**a third-party demo plugin built outside the monorepo against published
1.0 types**.
- **Tests:** malicious-plugin fixture (permission violations blocked +
  reported); external plugin installs → passes conformance in the gate →
  runs isolated → renders its domain.
- **Exit:** the platform claim is demonstrated with a real external plugin.

### 12G — Docs site & M4 gate
`apps/docs-site` generated from plugin-api + guides, covering the full
authoring journey; the 30-minute real pair session on two machines (human
step); full-matrix regression (all backends × projections × domains);
verification table, both demos recorded, `docs/demos/m4.md`, DoD, tag
`phase-12`, draft the post-platform backlog.
- **Exit:** **M4 review held.** Meridian is a platform.

---

## Session count summary

| Phase | Subphases | Of which ADR/gate | Build sessions |
|---|---|---|---|
| 2Z close-out | 1 | 1 | 0 |
| 3 | 5 | 2 | 3 |
| 4 | 5 | 2 | 3 |
| 5 | 6 | 2 | 4 |
| 6 | 5 | 2 | 3 |
| 7 | 8 | 2 | 6 |
| 8 | 6 | 2 | 4 |
| 9 | 5 | 2 | 3 |
| 10 | 6 | 2 | 4 |
| 11 | 7 | 2 | 5 |
| 12 | 7 | 2 | 5 |
| **Total** | **61** | **21** | **40** |

Every subphase ends with a green suite and a commit; every phase still ends
with the roadmap's own gate, closed by you.
