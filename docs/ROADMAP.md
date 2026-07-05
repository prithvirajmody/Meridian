# Meridian — Implementation Roadmap

**Project codename:** *Meridian* (placeholder — a universal semantic graph with map-like semantic zoom).
**Status:** Draft roadmap, created 2026-07-05. No code exists yet; this document is the contract for building it.
**Audience:** the engineer(s) who will build this incrementally — including future sessions of the authoring agent.

This document is self-contained and independent of the PyBCI SandBox plans in
`docs/plans/`. It follows the same house discipline: **no phase is done until
its tests pass and its Definition of Done is met**, and every phase leaves a
fully working, demonstrable system.

---

## Table of contents

1. [Vision restated as architecture](#1-vision-restated-as-architecture)
2. [Why thirteen phases](#2-why-thirteen-phases)
3. [Executive roadmap](#3-executive-roadmap)
4. [Phase dependency graph](#4-phase-dependency-graph)
5. [Global engineering conventions](#5-global-engineering-conventions)
6. [Technology recommendations](#6-technology-recommendations)
7. [Repository structure as it evolves](#7-repository-structure-as-it-evolves)
8. [Detailed phase breakdowns](#8-detailed-phase-breakdowns) (Phases 0–12)
9. [Milestones — what exists after each](#9-milestones)
10. [Risk reduction ledger](#10-risk-reduction-ledger)

---

## 1. Vision restated as architecture

The product idea — "everything is a graph, every node may contain a graph,
zoom changes abstraction, AI builds the abstractions" — decomposes into six
independent concerns. Each is a layer with a hard boundary; the roadmap's
phase structure falls directly out of these boundaries.

```
┌─────────────────────────────────────────────────────────────────────┐
│  L6  Collaboration & platform      shared sessions, plugin registry │
├─────────────────────────────────────────────────────────────────────┤
│  L5  Interaction & views           semantic zoom, navigation,       │
│                                    view projections (map/outline/…) │
├─────────────────────────────────────────────────────────────────────┤
│  L4  Presentation                  layout engine, WebGL renderer    │
├─────────────────────────────────────────────────────────────────────┤
│  L3  Intelligence                  AI extraction, summarization,    │
│                                    clustering (behind interfaces)   │
├─────────────────────────────────────────────────────────────────────┤
│  L2  Domain plugins                code / conversations / arguments │
│                                    / documents → semantic graph     │
├─────────────────────────────────────────────────────────────────────┤
│  L1  Semantic core                 graph model, recursive           │
│                                    containment, abstraction levels, │
│                                    store, deltas, queries           │
└─────────────────────────────────────────────────────────────────────┘
```

**Dependency rules (enforced mechanically from Phase 0):**

- L1 depends on nothing. It never imports DOM, React, an AI SDK, or any
  domain vocabulary. It is a pure TypeScript library that runs in Node, a
  worker, and a browser identically.
- L2 depends only on L1 and the plugin API. Domain knowledge lives *only*
  here. The core never knows what a "function" or a "rebuttal" is — it knows
  namespaced node kinds like `code:function` and `argument:rebuttal`.
- L3 implements L1/L2 interfaces (`AbstractionProvider`, `StructureExtractor`)
  — the system must be fully functional with deterministic, non-AI providers,
  because tests, offline use, and cost control all demand it. AI is an
  *upgrade* to abstraction quality, never a load-bearing dependency of the
  core pipeline.
- L4 consumes read-only view-models derived from L1. Layout and rendering
  never mutate the semantic graph.
- L5 orchestrates L1+L4. Semantic zoom is a *core* computation (which nodes
  are visible at abstraction cut C) plus a *presentation* concern (how the
  transition animates); the two are kept separable.
- L6 is only possible because L1's mutation model is an operation log from
  day one (Phase 1 decision). Collaboration is designed-for early, built late.

**Two structural insights the whole design leans on** (they appear repeatedly
in the phase details, so they are named here):

1. **Flat graph space, not nested documents.** Recursion is represented as a
   flat collection of graphs (`GraphSpace: Map<GraphId, SemanticGraph>`) where
   a node optionally carries `detail: GraphRef` pointing at another graph in
   the space. Nothing is physically nested. This makes lazy loading, partial
   hydration, structural sharing, and cross-graph references tractable at
   scale, and it means "zoom in" is a pointer dereference, not a tree walk.
2. **A zoom level is a *cut*.** The containment relation forms a forest. A
   "level of abstraction" is an antichain (a *cut*) through that forest that
   covers every leaf exactly once. Edges the user sees at a given cut are
   *induced*: an edge between two deep nodes appears as an aggregated,
   weighted edge between their ancestors in the current cut. Semantic zoom is
   the act of moving the cut; Google-Maps behavior falls out of interpolating
   between two cuts. This single formalism serves every domain.

---

## 2. Why thirteen phases

The phase count is derived, not chosen. Counting the independently shippable,
independently testable increments along the layer boundaries:

- **L1 (semantic core)** has three genuinely separate deliverables, each a
  precondition for everything after it and each testable headless: the typed
  model + serialization (Phase 0), the mutation/store/delta machinery
  (Phase 1), and the abstraction/cut formalism (Phase 3). Between the first
  two and the third sits the plugin contract (Phase 2), because the cut
  machinery should be validated against a *real ingested domain*, not only
  synthetic fixtures.
- **L4 (presentation)** splits into layout (Phase 4) and rendering (Phase 5):
  different risk profiles (algorithmic vs GPU/perf), different test harnesses
  (golden SVG snapshots vs pixel/FPS benchmarks), and layout is fully
  verifiable without a browser.
- **L5 (interaction)** splits into the signature semantic-zoom experience
  (Phase 6) and alternative view projections (Phase 10) — the second is
  valuable but must not block the domain/AI track.
- **L2 (domains)** needs one deterministic adapter early to prove the plugin
  contract (inside Phase 2), one *hard, real* domain to prove the whole
  pipeline (source code, Phase 7), and a pair of AI-native domains to prove
  generality — the "rule of three" before freezing the plugin API (Phase 9).
- **L3 (intelligence)** is one phase (Phase 8): the AI gateway plus AI-backed
  implementations of already-existing interfaces. It is deliberately *after*
  Phase 7 so AI quality can be judged against a rich, real graph.
- **Scale hardening** (Phase 11) and **collaboration/platform** (Phase 12)
  are each a coherent, deferrable increment.

That yields **13 phases, numbered 0–12**, grouped into **4 milestones**:

| Milestone | After phase | One-line definition |
|---|---|---|
| **M1 — Headless semantic core** | 3 | The universal graph, mutation, plugins, and semantic LOD all work and are fully tested — with zero pixels drawn |
| **M2 — The zoomable map** | 6 | The signature experience: open a document, see a map, zoom through abstraction levels smoothly |
| **M3 — Intelligent & multi-domain** | 9 | Code, conversations, and arguments all render as zoomable maps; AI names, summarizes, and clusters |
| **M4 — Platform** | 12 | Multiple view modes, big-graph scale, persistence, collaboration, and a publishable plugin SDK |

Not 5, not 10: fewer phases would fuse increments with different risk
profiles (layout+rendering, or store+abstraction) into un-gateable blobs;
more would manufacture ceremony around increments that can't actually ship
alone (e.g. an AI gateway with no consumer).

---

## 3. Executive roadmap

| # | Phase | Layer | Depends on | Primary risk retired | Demo at end |
|---|-------|-------|-----------|----------------------|-------------|
| 0 | Foundations & core graph model | L1 | — | "The universal model can't represent recursion cleanly" | CLI validates & prints stats for a hand-written 4-level nested graph |
| 1 | Graph store, deltas & queries | L1 | 0 | "Incremental updates / undo / collaboration were bolted on too late" | CLI applies scripted deltas; watch mode streams change events |
| 2 | Plugin architecture & first adapter | L2 | 1 | "Domain logic leaks into the core" | `meridian ingest doc.md` → nested semantic graph, via a plugin the core knows nothing about |
| 3 | Abstraction levels & semantic LOD (headless) | L1 | 2 | "Semantic zoom is hand-waving, not a formalism" | `meridian cut --level N` prints the visible node set + induced edges at any level |
| 4 | Layout engine | L4 | 3 | "Layout can't keep up / isn't stable across zoom" | `meridian layout --svg` exports an inspectable laid-out SVG of any cut |
| 5 | Renderer & app shell | L4 | 4 | "WebGL at 10k nodes @60fps is harder than expected" | Open Meridian Studio, pan/zoom/hover/select a 10k-node graph at 60fps |
| 6 | Semantic zoom & navigation | L5 | 5 | "The signature interaction doesn't feel like Maps" | Zoom a Markdown book: chapters → sections → paragraphs, continuously |
| 7 | Source-code domain adapter | L2 | 2,3 (∥ 4–6) | "A real, hard domain breaks the model" | Load a real repo; zoom project → module → function → CFG → AST |
| 8 | AI reasoning layer | L3 | 7 | "AI output is unusable / untestable / unaffordable" | Modules get AI names & summaries; an unstructured node soup gets clustered and labeled |
| 9 | AI-native domains: conversations & arguments | L2 | 8 | "The plugin API only fits tree-shaped domains" | Load an exported LLM conversation; zoom topics → exchanges → messages |
| 10 | View projections (multiple visualization modes) | L5 | 6,9 | "One rendering mode was secretly hard-coded everywhere" | Same conversation as map, outline, matrix, and timeline — selection survives switching |
| 11 | Scale, persistence & incremental hardening | L1/L4 | 7,10 | "Falls over at real-world sizes" | A ~1M-LOC monorepo is navigable; edit a file, watch the map update in <1s |
| 12 | Collaboration & platform | L6 | 11 | "Multiplayer requires a rewrite" | Two browsers, one graph: shared cursors, live co-navigation; a third-party plugin installs from a registry manifest |

Parallelization: after Phase 3 (M1), the **visual track** (4→5→6) and the
**domain track** (7) proceed in parallel. Phase 8 needs only Phase 7's output
graph; Phase 10 can start once 6 and 9 exist. Nothing else overlaps.

---

## 4. Phase dependency graph

```
            ┌────┐
            │ P0 │ foundations + model
            └─┬──┘
            ┌─▼──┐
            │ P1 │ store + deltas
            └─┬──┘
            ┌─▼──┐
            │ P2 │ plugins + markdown adapter
            └─┬──┘
            ┌─▼──┐
            │ P3 │ abstraction / LOD  ═══ M1
            └─┬──┘
        ┌─────┴──────────┐
   ┌────▼───┐        ┌───▼────┐
   │   P4   │ layout │   P7   │ code adapter
   └────┬───┘        └───┬────┘
   ┌────▼───┐        ┌───▼────┐
   │   P5   │ render │   P8   │ AI layer
   └────┬───┘        └───┬────┘
   ┌────▼───┐        ┌───▼────┐
   │   P6   │ zoom   │   P9   │ AI domains
   └────┬───┘  ═ M2  └───┬────┘  ═ M3 (with P6)
        └───────┬────────┘
            ┌───▼───┐
            │  P10  │ view projections
            └───┬───┘
            ┌───▼───┐
            │  P11  │ scale + persistence
            └───┬───┘
            ┌───▼───┐
            │  P12  │ collaboration + platform  ═══ M4
            └───────┘
```

Notes on the two soft edges not drawn: P7 formally depends on P2 (plugin
contract) and P3 (level chains) but not on the visual track — it is developed
and tested headless, then simply *appears* in the Studio once P5/P6 exist.
P8's gateway has no dependency on P4–P6 at all.

---

## 5. Global engineering conventions

These apply to **every** phase. Each phase's "Verification" section assumes
them and adds phase-specific tests on top.

### 5.1 The phase gate

A phase is complete only when **all** of the following hold. No exceptions,
no "we'll fix it in the next phase":

1. Every test category listed in the phase's verification table passes in CI.
2. The phase's Definition of Done checklist is literally checked off.
3. The demo listed in §3 has been performed and (for visual phases) recorded.
4. `main` is green; the system runs end-to-end via one documented command.
5. All technical decisions listed under "must be finalized" have an ADR
   (architecture decision record) in `docs/adr/` — a decision without a
   written ADR is not finalized.

### 5.2 Testing philosophy → concrete harnesses

The eight required verification categories map to fixed tooling, so every
phase fills in the same table rather than reinventing process:

| Category | Harness | Standing rule |
|---|---|---|
| **Unit** | Vitest (+ fast-check for property tests) | Every exported function of every package. Property tests are mandatory for core invariants (see 5.3). |
| **Integration** | Vitest, multi-package; CLI golden-file tests | Exercise real package boundaries — no mocking a sibling package you own. |
| **Performance** | tinybench suites in `benchmarks/`, run in CI against pinned thresholds | A perf budget is a *test*: exceeding it fails CI. Budgets only ratchet down. |
| **UI verification** | Playwright: screenshot baselines (pixel-diff), interaction scripts, FPS sampling via `PerformanceObserver` | Applies from Phase 5 onward; earlier phases substitute golden SVG snapshots. |
| **Architecture verification** | dependency-cruiser rules committed in repo root; `tsc --noEmit` strict; API-surface snapshot via `api-extractor` | Forbidden-import rules (e.g. "graph-core may not import react/pixi/anthropic") fail CI on violation. Public API changes require an intentional snapshot update. |
| **Manual exploratory** | A literal checklist in the phase's `docs/meridian/checklists/phase-NN.md`, checked off in the closing PR | Covers what automation can't: feel of zoom, readability of AI labels, jank. |
| **Failure cases** | Dedicated `*.failure.test.ts` suites | Malformed inputs, plugin crashes, AI garbage output, worker death, network loss. Every phase names its failure modes and tests them. |
| **Regression** | The entire accumulated suite of all prior phases, plus golden corpora (serialized graphs, layouts, screenshots) under `fixtures/` | Golden files change only via an explicit, reviewed `pnpm goldens:update`. |

### 5.3 Standing core invariants (property-tested from Phase 0 onward)

- **I1 — Referential integrity:** every edge endpoint resolves to a node in
  the same graph; every `detail: GraphRef` resolves within the `GraphSpace`.
- **I2 — Acyclic containment:** the graph-contains-graph relation is a forest
  (no graph is its own ancestor).
- **I3 — Round-trip fidelity:** `parse(serialize(g))` is deep-equal to `g`
  for every valid graph.
- **I4 — Delta soundness:** `apply(g, delta)` yields a valid graph or rejects
  atomically; `apply(apply(g, d), invert(d)) ≡ g`.
- **I5 — Cut coverage:** every resolved LOD cut covers every leaf of the
  containment forest exactly once (from Phase 3).
- **I6 — Determinism:** all non-AI pipelines are bit-deterministic given the
  same input; AI pipelines are deterministic under the record/replay cache.

### 5.4 Documentation discipline

- One ADR per finalized decision (`docs/adr/NNNN-title.md`, ~1 page).
- Every package has a `README.md` stating its responsibility, its public API
  entry point, and what it is forbidden from importing.
- CHANGELOG per package once the plugin API ships (Phase 2), because plugin
  authors are downstream consumers even while "plugin authors" means us.

---

## 6. Technology recommendations

| Concern | Choice | Why (and what was rejected) |
|---|---|---|
| Language | **TypeScript, `strict` + `noUncheckedIndexedAccess`, ESM-only** | The system spans browser, workers, and Node; one language keeps the semantic core isomorphic. Strong typing is a stated requirement; branded types (`NodeId`, `GraphId`) prevent ID-mixups at compile time. Rust/WASM for hot paths is deliberately *deferred* until Phase 11 proves a need — premature WASM would tax every contributor. |
| Monorepo | **pnpm workspaces + Turborepo** | Cheap package boundaries are the enforcement mechanism for the layer rules; pnpm's strictness (no phantom deps) makes illegal imports fail early. Turborepo caches the build/test graph. Nx rejected as heavier than needed. |
| Schema & validation | **zod** (runtime) mirrored by TS types (compile time) | Graph documents, plugin manifests, and AI outputs all cross trust boundaries; zod gives one source of truth for parse-don't-validate at those boundaries. |
| Immutability | **Hand-rolled copy-on-write over native `Map` with versioned indices** (Phase 1) | immer is too slow for 10⁵-node deltas; Immutable.js drags a foreign API through every signature. A small CoW layer over native Maps, with structural sharing at the graph level (not per-node), is simpler and benchmarkable. This is ADR-gated in Phase 1 with an escape hatch to a HAMT library if benchmarks fail. |
| Layout | **elkjs** (layered/hierarchical) + **d3-force** (organic) + trivial grid/tree fallbacks, all in **Web Workers** via Comlink | ELK is the only serious open-source layered engine with ports/compound-node support (compound nodes = our nested graphs). Force layout covers cluster views. Workers keep the main thread at 60fps; the `LayoutProvider` interface keeps engines swappable. |
| Rendering | **pixi.js v8** (WebGL2, WebGPU-ready) with instanced node quads + SDF/BitmapText labels; React never touches the canvas | 10k+ nodes rules out SVG/DOM. Building raw regl/WebGL is a rendering-engine project of its own; pixi v8 gives batching, texture atlases, and a maintained WebGPU path while we keep a thin `SceneAdapter` so it stays replaceable. sigma.js rejected: too opinionated about being *the* graph model. |
| App shell | **React 18 + Vite + zustand** | React for chrome (panels, search, breadcrumbs) only; the canvas is an imperative island receiving a view-model. zustand over Redux: minimal ceremony, store lives outside React (workers/canvas need it too). |
| Parsing (code domain) | **web-tree-sitter (WASM)** grammars | Incremental, error-tolerant, runs in browser and Node identically, one API across languages. Compiler-grade type resolution deliberately out of scope until proven necessary. |
| AI | **Claude API via `@anthropic-ai/sdk`**, behind our own `AiProvider` interface. Default model `claude-opus-4-8` for extraction/summarization; `claude-haiku-4-5` for bulk short labels; **structured outputs** (`output_config.format` + zod) for every graph-shaped response; **Batches API** for whole-corpus ingestion (50% cost); **prompt caching** for shared graph context; embeddings via a pluggable provider (e.g. Voyage) since the core only needs vectors | The provider interface — not the vendor — is the architectural commitment. Structured outputs eliminate an entire class of "AI returned malformed graph" failures; record/replay caching (Phase 8) makes AI paths deterministic in CI. |
| Persistence | **JSON graph documents** (Phases 0–10) → **SQLite** (wa-sqlite/OPFS in browser, better-sqlite3 in Node) with lazy per-graph hydration (Phase 11) | Start with dumb, diffable, git-friendly files; adopt a real store only when scale demands, behind the same `GraphStore` interface. |
| Collaboration | **Deferred decision** (ADR in Phase 12): server-authoritative op-log sequencer (recommended) vs CRDT (Yjs) | Phase 1's op-based deltas keep both doors open. Recommendation recorded now: op-log + server sequencing is dramatically simpler and sufficient unless offline editing becomes a requirement — the ADR must revisit with real requirements. |
| Testing | **Vitest, fast-check, Playwright, tinybench, dependency-cruiser, api-extractor** | See §5.2. |
| CI | **GitHub Actions**: lint → typecheck → depcruise → unit/integration → benchmarks → Playwright | The phase gate, mechanized. |

---

## 7. Repository structure as it evolves

One monorepo. Packages appear only in the phase that introduces them — an
empty placeholder package is a lie about the architecture.

**After M1 (Phase 3):**

```
meridian/
├── packages/
│   ├── graph-core/          # P0: model, ids, validation, (de)serialization
│   ├── graph-store/         # P1: store, deltas, transactions, indices, queries
│   ├── plugin-api/          # P2: the thin, semver-disciplined plugin contract
│   ├── plugin-host/         # P2: registry, loading, capability resolution
│   ├── conformance-kit/     # P2: reusable test suite any adapter must pass
│   ├── abstraction/         # P3: level chains, cuts, induced edges, LOD resolver
│   └── adapters/
│       └── markdown/        # P2: first deterministic domain adapter
├── apps/
│   └── cli/                 # P0+: meridian validate|stats|ingest|mutate|cut
├── fixtures/                # golden graphs & corpora
├── benchmarks/
├── docs/adr/
└── (turbo.json, pnpm-workspace.yaml, .dependency-cruiser.cjs, …)
```

**M2 adds (Phases 4–6):**

```
│   ├── layout/              # P4: LayoutProvider, elk/force/tree providers, worker host
│   ├── renderer/            # P5: pixi scene, culling, picking, camera
│   ├── view-model/          # P5: cut+layout+selection → render-ready view state
│   └── navigation/          # P6: semantic zoom controller, transitions, breadcrumbs
├── apps/
│   └── studio/              # P5: the Meridian Studio web app (Vite + React shell)
```

**M3 adds (Phases 7–9):**

```
│   ├── ai/                  # P8: AiProvider gateway, cache, budget, record/replay
│   ├── ai-services/         # P8: summarizer, clusterer, structure extractor
│   └── adapters/
│       ├── code/            # P7: tree-sitter based; + grammars/ WASM assets
│       ├── conversation/    # P9
│       └── argument/        # P9
├── evals/                   # P8: offline AI quality evals + scored fixtures
```

**M4 adds (Phases 10–12):**

```
│   ├── projections/         # P10: map / outline / matrix / timeline projections
│   ├── store-sqlite/        # P11: persistent GraphStore backend
│   └── sync-protocol/       # P12: wire types shared by client & server
├── services/
│   └── sync/                # P12: op-log sequencer + presence (Node, WebSocket)
├── apps/
│   └── docs-site/           # P12: public plugin SDK documentation
```

---

## 8. Detailed phase breakdowns

Each phase follows the same 13-section template. "Interfaces" and "Data
structures" show *shape*, not final code — the phase's ADRs finalize them.

---

### Phase 0 — Foundations & the core graph model

**1. Goal.** A buildable, CI-gated monorepo containing `@meridian/graph-core`:
the typed universal semantic graph with recursive containment, a versioned
portable document format, validation, and a CLI that proves it headless.

**2. Motivation.** Every later phase consumes this model; every mistake here
is multiplied by twelve phases. The recursion representation and the ID
scheme are the two decisions that are near-impossible to reverse later, so
they are made first, in isolation, with property tests — before any pixels,
plugins, or AI can pressure the model into shortcuts.

**3. Deliverables.**
- Monorepo scaffold: pnpm + Turborepo, strict TS config shared via
  `tsconfig.base.json`, ESLint, dependency-cruiser rules, CI pipeline,
  ADR template + first ADRs.
- `@meridian/graph-core`: model types, constructors, validators,
  serialization to/from the `GraphDocument` JSON format (versioned
  `formatVersion: 1`), stable-ID utilities.
- `apps/cli` (`meridian`): `validate`, `stats`, `inspect <nodeId>`.
- Fixture corpus: hand-written nested graphs (≥4 levels deep, cross-graph
  edges, unicode labels, adversarial cases).

**4. Components introduced.** `graph-core`, `cli`, CI, ADR process,
fixtures/goldens mechanism.

**5. Interfaces that should exist.**

```ts
interface GraphValidator {
  validate(space: GraphSpace): ValidationResult;   // I1, I2 enforced here
}
interface GraphCodec {
  encode(space: GraphSpace): GraphDocument;        // versioned, portable
  decode(doc: GraphDocument): GraphSpace;          // parse-don't-validate (zod)
}
```

**6. Public APIs.** `createGraphSpace`, `addGraph/addNode/addEdge` (pure,
returning new values — mutation machinery comes in P1), `validate`,
`encode/decode`, `stats(space)`; CLI: `meridian validate <file>`,
`meridian stats <file>`, `meridian inspect <file> <nodeId>`.

**7. Data structures.**

```ts
type NodeId = Brand<string, 'NodeId'>;       // likewise GraphId, EdgeId
interface GraphSpace { graphs: ReadonlyMap<GraphId, SemanticGraph>; roots: GraphId[]; }
interface SemanticGraph {
  id: GraphId;
  nodes: ReadonlyMap<NodeId, SemanticNode>;
  edges: ReadonlyMap<EdgeId, SemanticEdge>;
  meta: GraphMeta;                            // domain, label, provenance
}
interface SemanticNode {
  id: NodeId;
  kind: string;                               // namespaced: 'code:function', 'doc:section'
  label: string;
  detail?: GraphRef;                          // ← the recursion: node contains a graph
  attrs: AttrBag;                             // typed core fields + namespaced extension bag
  provenance: SourceRef;                      // where this came from (file/span/msg/ai)
}
interface SemanticEdge { id: EdgeId; src: NodeId; dst: NodeId; kind: string; weight?: number; attrs: AttrBag; }
interface SourceRef { origin: 'source' | 'derived' | 'ai'; uri?: string; span?: [number, number]; model?: string; confidence?: number; }
```

**8. Technical decisions that must be finalized (ADRs).**
- **ADR-0001 Recursion representation:** flat `GraphSpace` + `GraphRef`
  (per §1). Alternatives (physically nested documents) recorded and rejected.
- **ADR-0002 ID scheme:** stable, deterministic IDs derived from
  `(domain, sourcePath, semanticPath)` hashes — *not* random UUIDs — so
  re-ingesting unchanged sources yields identical IDs (prerequisite for
  incremental updates and cross-run diffing). Alias table reserved for renames.
- **ADR-0003 Attribute typing:** small set of typed core attributes +
  namespaced extension bag (`'code:cyclomatic': number`) validated by
  plugin-supplied zod schemas later.
- **ADR-0004 Document format & versioning policy** (`formatVersion`,
  forward-compat rules, migration hook signature).

**9. Risks.** (a) Over-modeling: designing attributes for domains that don't
exist yet — mitigated by allowing only what the fixture corpus needs.
(b) Under-modeling recursion (e.g. forgetting that an edge may need to cross
graph boundaries — resolved now: cross-graph edges are *not* allowed in the
model; they are represented at the lowest common graph and *induced* upward,
per ADR-0001). (c) Tooling yak-shaving — capped at two days by decree.

**10. Intentionally deferred.** Mutation (P1), any plugin awareness (P2),
levels/cuts (P3), persistence beyond JSON files, performance work beyond
"stats on 100k nodes doesn't hang".

**11. Acceptance criteria.**
- All fixture graphs round-trip (I3) and validate (I1, I2).
- Adversarial fixtures (dangling edge, containment cycle, duplicate ID,
  unknown formatVersion) are *rejected with precise, located errors*.
- CLI works end-to-end on a file; `--json` output is stable for scripting.
- dependency-cruiser proves `graph-core` imports nothing but zod + stdlib.

**12. Verification required before Phase 1.**

| Category | This phase |
|---|---|
| Unit | Model constructors, validators, codec; fast-check property suites for I1–I3 over generated random graph spaces |
| Integration | CLI golden-file tests: `validate`/`stats` output for every fixture |
| Performance | `decode+validate` of a synthetic 100k-node space < 1.5s; `stats` < 200ms (thresholds in CI) |
| UI verification | N/A — substitute: `meridian stats` human-readable output reviewed against checklist |
| Architecture | depcruise rules green; api-extractor snapshot of `graph-core` committed |
| Manual exploratory | Author a new nested graph by hand from docs alone — the doc gaps found become fixes |
| Failure cases | Malformed JSON, truncated file, unknown version, 10-level containment cycle |
| Regression | Golden fixtures locked; goldens-update flow documented and exercised once |

**13. Definition of Done.** Phase gate (§5.1) passes; ADR-0001…0004 merged;
a newcomer can clone, `pnpm i && pnpm test && pnpm meridian validate
fixtures/deep-nest.meridian.json` successfully with no tribal knowledge.

---

### Phase 1 — Graph store, deltas & queries

**1. Goal.** The mutation layer: an in-memory `GraphStore` holding immutable
snapshots, mutated exclusively through op-based `GraphDelta`s applied in
transactions, with change subscriptions, secondary indices, and a traversal/
query API.

**2. Motivation.** Three stated requirements — efficient incremental
updates, tens-of-thousands-of-nodes scale, and future multiplayer — share one
correct foundation: *all mutation is an ordered log of typed operations*.
Retrofitting an op log onto ad-hoc mutation is the classic collaboration
rewrite; we pay for it now, while the codebase is one package.

**3. Deliverables.** `@meridian/graph-store`; delta/op type family + inverses;
transaction API with atomic validation; subscription API (batched change
events); adjacency + kind + label-token indices maintained incrementally;
query/traversal API; CLI `meridian mutate <file> --script ops.json` and
`meridian watch`.

**4. Components introduced.** `graph-store`; benchmark suite becomes real.

**5. Interfaces that should exist.**

```ts
interface GraphStore {
  snapshot(): GraphSpace;                       // immutable, structurally shared
  version(): VersionStamp;
  apply(delta: GraphDelta): ApplyResult;        // atomic; validates I1/I2
  transact(fn: (tx: GraphTransaction) => void): ApplyResult;
  subscribe(listener: (change: ChangeSet) => void, opts?: SubscribeOpts): Unsubscribe;
  query(): GraphQuery;                          // fluent: byKind, neighbors, within(graph), text
}
interface GraphTransaction { addNode(...); removeNode(...); setAttr(...); addEdge(...); setDetail(...); /* … */ }
```

**6. Public APIs.** `createStore(space)`, `applyDelta`, `invertDelta`,
`composeDeltas`, `diffSpaces(a, b): GraphDelta` (state-diff utility for
adapters that can't emit ops natively); query builder.

**7. Data structures.**

```ts
interface GraphDelta { baseVersion: VersionStamp; ops: GraphOp[]; origin: OpOrigin; }
type GraphOp =
  | { t: 'node:add'; graph: GraphId; node: SemanticNode }
  | { t: 'node:remove'; graph: GraphId; id: NodeId }
  | { t: 'node:attr'; graph: GraphId; id: NodeId; key: string; prev: unknown; next: unknown }
  | { t: 'node:detail'; graph: GraphId; id: NodeId; prev?: GraphRef; next?: GraphRef }
  | { t: 'edge:add' | 'edge:remove'; /* … */ }
  | { t: 'graph:add' | 'graph:remove'; /* … */ };
interface ChangeSet { fromVersion: VersionStamp; toVersion: VersionStamp; ops: GraphOp[]; touched: { graphs: Set<GraphId>; nodes: Set<NodeId> }; }
```

Ops carry `prev` values so every delta is invertible (I4) — this is the undo
system *and* the collaboration substrate.

**8. Technical decisions that must be finalized (ADRs).**
- **ADR-0005 Op-based (not state-based) deltas**, op vocabulary v1, and the
  rule that ops are the only mutation path.
- **ADR-0006 CoW/structural-sharing strategy** (hand-rolled over native Map;
  escape hatch criteria to a HAMT library = failing the perf budgets below).
- **ADR-0007 Version stamps** (monotonic per-store lamport-style stamp;
  reserved fields for site-ID so P12 can extend, not replace).
- **ADR-0008 Subscription semantics:** batched per-transaction, delivered
  async microtask; no re-entrant mutation from listeners.

**9. Risks.** (a) Perf of naive copying — that's why the budgets below are
CI gates, not aspirations. (b) Op vocabulary too small (discovered in P7 when
code re-ingestion needs `node:move`) — mitigated: vocabulary is versioned and
additive by design. (c) Query API scope creep — capped to what P3–P7
demonstrably need.

**10. Intentionally deferred.** Persistence (P11), multi-writer concurrency
and conflict resolution (P12), cross-store sync, query optimizer.

**11. Acceptance criteria.** I4 property-verified; subscriptions deliver
exactly-once, in-order batches; `diffSpaces` produces a delta that replays
a→b for arbitrary generated pairs; indices provably consistent with
brute-force recomputation on random op sequences.

**12. Verification required before Phase 2.**

| Category | This phase |
|---|---|
| Unit | Every op type: apply/invert/compose; fast-check I4; index-vs-bruteforce equivalence properties |
| Integration | CLI `mutate` + `watch` golden tests; store consumed by `graph-core` validators unchanged |
| Performance | Apply a 10k-op delta < 50ms; snapshot() O(1); 1k sequential transactions on a 100k-node space < 2s; memory: snapshot chain of 100 versions shares ≥90% of node objects (heap-sampled test) |
| UI verification | N/A — `meridian watch` output reviewed |
| Failure cases | Delta against stale baseVersion rejected; op referencing missing node → atomic rollback; listener throwing doesn't poison the store |
| Architecture | `graph-store` imports only `graph-core`; api snapshot |
| Manual exploratory | Script a 20-step editing session via CLI; undo it all via inverted deltas |
| Regression | P0 suite green; P0 fixtures now also run through store round-trip |

**13. Definition of Done.** Phase gate passes; undo/redo demonstrably works
via `invertDelta` in a CLI session; perf budgets locked into CI.

---

### Phase 2 — Plugin architecture & the first domain adapter

**1. Goal.** A versioned plugin contract (`@meridian/plugin-api`), a host that
registers/loads plugins and resolves capabilities, a reusable conformance
test kit, and the first real `DomainAdapter` — Markdown/outline — chosen
because it is deterministic, familiar, and genuinely hierarchical without
needing any AI.

**2. Motivation.** "Avoid tightly coupling any domain-specific logic into the
core" is only true if it is *mechanically impossible* to violate. Introducing
the plugin boundary while there is exactly one adapter is the cheapest moment
to get the contract shape right; the conformance kit turns the contract into
executable law that every future adapter (ours or third-party) must pass.

**3. Deliverables.** `plugin-api` (types only — deliberately dependency-thin
so third parties can target it painlessly), `plugin-host` (registry, manifest
validation, lifecycle, error isolation), `conformance-kit` (a Vitest suite
factory: `describeAdapterConformance(adapter, corpus)`), `adapters/markdown`,
CLI `meridian ingest <source> --adapter markdown`.

**4. Components introduced.** The L1/L2 boundary itself; the notion of a
`SourceDescriptor`; adapter corpora under `fixtures/corpora/markdown/`.

**5. Interfaces that should exist.**

```ts
interface MeridianPlugin {
  manifest: PluginManifest;                      // zod-validated
  activate(ctx: PluginContext): PluginExports;   // no I/O in module scope
}
interface PluginManifest {
  name: string; version: string;
  apiVersion: string;                            // semver range against plugin-api
  capabilities: CapabilityDeclaration[];         // 'domain-adapter' | (later) 'abstraction-provider' | 'view-projection' | 'ai-provider'
  attrSchemas?: Record<string, ZodSchemaJson>;   // namespaced attr validation (ADR-0003)
}
interface DomainAdapter {
  readonly domain: string;                       // 'markdown'
  sniff(src: SourceDescriptor): number;          // 0..1 confidence it can handle src
  ingest(src: SourceDescriptor, sink: IngestSink): Promise<void>;
  // sink accepts either a complete GraphDocument or a stream of GraphDeltas —
  // streaming from day one so P7/P11 don't need a second contract
}
interface IngestSink { emitDocument(doc: GraphDocument): void; emitDelta(d: GraphDelta): void; progress(p: Progress): void; }
```

**6. Public APIs.** `registerPlugin`, `resolveAdapters(src)`,
`ingest(src, opts)`; conformance kit's `describeAdapterConformance`; CLI
`meridian ingest`, `meridian plugins list`.

**7. Data structures.** `SourceDescriptor` (`{ uri, mediaType?, bytes?/text? , meta }`),
`PluginManifest` (above), `IngestReport` (counts, warnings, provenance
summary, elapsed).

**8. Technical decisions that must be finalized (ADRs).**
- **ADR-0009 Plugin loading model:** in-process npm packages, statically
  imported by the host app, for the entire pre-M4 life of the project.
  Process/worker isolation and untrusted third-party loading are explicitly a
  Phase 12 concern — but the *contract* (no module-scope side effects,
  everything through `PluginContext`) is written now so isolation later is a
  host change, not a plugin change.
- **ADR-0010 plugin-api versioning policy:** semver; breaking changes only at
  declared checkpoints (next one: Phase 9 freeze to 1.0).
- **ADR-0011 Capability model:** enumerated capability kinds vs open-ended —
  enumerated, extended per phase.

**9. Risks.** (a) Contract shaped by a too-easy first domain (Markdown is
tree-shaped; graphs with heavy cross-links come later) — mitigated by writing
the conformance kit against the *contract*, not the adapter, and by P7/P9
being scheduled checkpoints allowed to amend it pre-1.0. (b) Host does too
much (scheduling, caching) — capped: host registers, validates, resolves,
isolates errors; nothing else.

**10. Intentionally deferred.** Sandboxing/untrusted plugins (P12), plugin
distribution (P12), abstraction-provider and view-projection capabilities
(declared in the enum, unimplemented until P3/P10), watch-mode re-ingestion
(P7).

**11. Acceptance criteria.** Markdown adapter passes the conformance kit;
core packages contain zero occurrences of the string `markdown` (depcruise +
grep gate); a malformed manifest or a throwing adapter is contained with a
useful error and cannot crash the host; `meridian ingest README.md` produces a
valid, deterministic, stable-ID graph (same file → byte-identical document).

**12. Verification required before Phase 3.**

| Category | This phase |
|---|---|
| Unit | Manifest validation; capability resolution; sniff arbitration; markdown → graph mapping rules |
| Integration | `meridian ingest` golden documents for the whole markdown corpus (incl. CommonMark edge cases, huge docs, pathological nesting) |
| Performance | Ingest a 5MB markdown book < 2s; conformance kit itself < 30s per adapter |
| UI verification | N/A |
| Architecture | depcruise: `graph-core`/`graph-store` may not import `plugin-*` or any adapter; adapters may not import each other |
| Manual exploratory | Write a toy "TODO-list" adapter in <1 hour using only `plugin-api` docs — friction found = docs/contract fixes |
| Failure cases | Adapter throws mid-stream (partial ingest rolled back atomically via P1 transactions); manifest apiVersion mismatch; two adapters sniff the same source |
| Regression | P0–P1 suites; markdown goldens locked |

**13. Definition of Done.** Phase gate passes; the toy-adapter exercise is
written up as the first draft of the plugin-author guide; ADR-0009…0011
merged.

---

### Phase 3 — Abstraction levels & semantic LOD (headless) — closes M1

**1. Goal.** Make abstraction a first-class, computable object: level chains,
refinements, cuts, induced/aggregated edges, and a deterministic LOD resolver
that answers *"given focus F and zoom scalar z, exactly which nodes and edges
are visible?"* — all headless, all property-tested.

**2. Motivation.** This is the intellectual heart of the product. If semantic
zoom is defined only by what the UI happens to do, it can never be tested,
never be consistent across domains, and never be computed server-side or
incrementally. Doing it before any rendering forces the formalism to stand on
its own.

**3. Deliverables.** `@meridian/abstraction`: `LevelChain` (named levels per
domain, e.g. code's project→…→expression), cut computation, induced-edge
aggregation with caching, `ZoomPolicy` (scalar→cut mapping with hysteresis),
per-node pin/expand overrides (the "focus+context" mechanism), deterministic
built-in `AbstractionProvider`s (containment rollup; degree/size-based
collapse for flat graphs), CLI `meridian cut --level N | --zoom 0.42 --focus <id>`.

**4. Components introduced.** `abstraction`; the `AbstractionProvider`
capability goes live in `plugin-api`.

**5. Interfaces that should exist.**

```ts
interface AbstractionProvider {
  // Given a graph with no (or partial) containment, propose grouping:
  propose(graph: SemanticGraph, ctx: AbstractionCtx): Promise<AbstractionProposal>;
}                                                  // deterministic impls now; AI impls in P8
interface LodResolver {
  resolve(req: LodRequest): LodResult;             // pure function of (space, levels, zoom, focus, overrides)
}
interface LodRequest { zoom: number; focus?: NodeId; overrides: ReadonlyMap<NodeId, 'pin' | 'expand' | 'collapse'>; viewportHint?: Budget; }
interface LodResult {
  cut: Cut;                                        // the visible antichain
  inducedEdges: InducedEdge[];                     // aggregated, weighted, deduped
  frontier: { expandable: NodeId[]; collapsible: NodeId[] };
  provenance: CutTrace;                            // why each node is in/out — debuggability is a feature
}
```

**6. Public APIs.** `buildLevelChain(space, spec)`, `resolveLod(req)`,
`aggregateEdges(space, cut)`, `applyProposal(store, proposal)` (proposals
become ordinary P1 deltas — AI later gets no special write path); CLI `cut`.

**7. Data structures.** `Cut` (ordered `NodeId[]` + covering proof),
`InducedEdge { src, dst, kind, weight, multiplicity, samples: EdgeId[] }`,
`LevelChainSpec` (per-domain named levels, contributed by adapters via
manifest), `ZoomPolicy { thresholds, hysteresis, budget }`,
`AbstractionProposal` (list of proposed group nodes + membership + rationale).

**8. Technical decisions that must be finalized (ADRs).**
- **ADR-0012 Zoom semantics:** hybrid — a global continuous zoom scalar maps
  to discrete level cuts with hysteresis, plus per-node overrides for local
  drill-down (Maps-like global zoom *and* "open just this one box").
- **ADR-0013 Induced-edge aggregation rules:** grouping key (kind), weight
  function, cap-with-"+n more" policy, cache invalidation via P1 ChangeSets.
- **ADR-0014 Node budget:** the resolver accepts a max-visible-nodes budget
  and degrades by collapsing lowest-salience subtrees — salience function v1
  (size, degree, recency) fixed here.

**9. Risks.** (a) The formalism fights ragged real-world hierarchies (mixed
depths, orphans) — mitigated by adversarial fixtures and by `CutTrace`
making resolver decisions inspectable. (b) Induced-edge computation is the
first potential perf cliff — hence its own benchmark gates now, not in P11.
(c) Hysteresis/threshold feel can't truly be judged headless — accepted:
constants are revisited in P6 with the real camera attached; the *mechanism*
is what's frozen here.

**10. Intentionally deferred.** AI-backed providers (P8), any animation or
camera math (P6), cross-cut diffing for transitions (P6), per-viewport
spatial culling (P5 — that's geometric, not semantic).

**11. Acceptance criteria.** I5 (cut coverage) property-verified on random
forests; resolver is a pure deterministic function (same request → identical
result, verified by hashing); induced edges match brute-force on random
graphs; markdown corpus gets a working default level chain with zero
adapter changes (containment rollup suffices).

**12. Verification required before Phase 4.**

| Category | This phase |
|---|---|
| Unit | Cut construction, override interactions (pin inside collapsed ancestor, etc.), zoom↔level mapping incl. hysteresis; fast-check I5 + induced-edge-vs-bruteforce |
| Integration | `meridian cut` goldens across the markdown corpus at every level; proposals applied through the real store |
| Performance | Resolve on a 100k-node/8-level synthetic forest < 30ms warm / < 150ms cold; induced-edge cache invalidation touches only affected ancestors (op-count asserted) |
| UI verification | N/A |
| Architecture | `abstraction` imports `graph-core`/`graph-store` only |
| Manual exploratory | Walk a real book through every level via CLI; sanity-judge whether each cut "reads" like a sensible summary of the one below |
| Failure cases | Empty graph, single-node graph, forest with 1M leaves under one parent (budget must kick in), override map referencing removed nodes |
| Regression | P0–P2 suites; new goldens locked |

**13. Definition of Done.** Phase gate passes; **Milestone M1 review held**:
a written demo script (all-CLI) exercises ingest → mutate → cut end-to-end
and is checked into `docs/meridian/demos/m1.md`. The semantic core is now
frozen enough that two tracks proceed in parallel.

---

### Phase 4 — Layout engine

**1. Goal.** A pluggable, worker-hosted layout engine that turns
`(cut, inducedEdges)` into stable 2D positions, with incremental re-layout,
per-(version, cut, mode) caching, and an SVG snapshot exporter so layout
quality is reviewable and regression-testable without a renderer.

**2. Motivation.** Layout is the algorithmic risk of the visual track:
quality, stability (nodes must not teleport on small changes), and cost all
fight each other. Isolating it behind `LayoutProvider` — and validating it
via golden SVGs before any GPU code exists — means Phase 5 composes two
already-proven parts instead of debugging both at once.

**3. Deliverables.** `@meridian/layout`: `LayoutProvider` interface; providers
`elk-layered` (compound-aware — nested graphs become ELK compound nodes),
`d3-force` (organic/cluster views), `tree`, `grid` (deterministic fallbacks);
Comlink worker host with cancellation; `LayoutCache`; stability contract +
scorer; `meridian layout --svg out.svg`.

**4. Components introduced.** `layout`; first Web Worker infrastructure
(reused by P5 picking and P7 parsing).

**5. Interfaces that should exist.**

```ts
interface LayoutProvider {
  readonly id: string;
  readonly capabilities: { incremental: boolean; compound: boolean; deterministic: boolean };
  compute(input: LayoutInput, prev?: LayoutResult, signal?: AbortSignal): Promise<LayoutResult>;
}
interface LayoutInput { cut: Cut; edges: InducedEdge[]; sizes: ReadonlyMap<NodeId, Size>; hints: LayoutHints; }
interface LayoutResult { positions: ReadonlyMap<NodeId, Rect>; edgeRoutes?: ReadonlyMap<string, Point[]>; bounds: Rect; stability: number; }
```

**6. Public APIs.** `layout(input, opts)`, `warmCache(store, policy)`,
provider registration via `plugin-api` capability `layout-provider`; CLI
`meridian layout`.

**7. Data structures.** World-space coordinates: float64, y-down, arbitrary
units (ADR below); `LayoutHints` (direction, spacing, seed for force
determinism); cache key `(storeVersion, cutHash, providerId, hintsHash)`.

**8. Technical decisions that must be finalized (ADRs).**
- **ADR-0015 Coordinate system & units** (world-space f64 y-down; renderer
  owns all screen-space transforms — layout never sees pixels).
- **ADR-0016 Stability contract:** re-layout after a small delta must keep
  unchanged nodes within ε of prior positions (elk via position hints; force
  via warm-start from prev). Stability is a *scored, tested* number.
- **ADR-0017 Worker protocol:** transferable typed arrays for positions;
  cancellation semantics (new request aborts stale one).
- **ADR-0018 Default provider per view shape** (layered for DAG-ish cuts,
  force for cluster-ish; the heuristic that picks).

**9. Risks.** (a) elkjs cost on big compound graphs — measured now, with
budget gates, and the node-budget from ADR-0014 as the pressure valve.
(b) Force-layout nondeterminism — seeded PRNG mandated; determinism is a
test. (c) Edge routing rabbit hole — v1 ships straight lines with optional
elk orthogonal routes; splines deferred.

**10. Intentionally deferred.** GPU/WASM layout, constraint-based layout,
edge bundling, user-draggable manual layout persistence (P10+), 3D.

**11. Acceptance criteria.** Golden SVGs for every corpus×provider pair look
right and are locked; stability score ≥ threshold on scripted small-delta
sequences; worker cancellation actually stops compute (measured); cache hit
returns < 1ms.

**12. Verification required before Phase 5.**

| Category | This phase |
|---|---|
| Unit | Providers on tiny graphs vs hand-computed truth; cache keying; hint plumbing |
| Integration | `meridian layout --svg` goldens (SVG normalized before diff); layout consumes real P3 cuts |
| Performance | elk on 2k-node compound cut < 1.5s worker-side; force 10k nodes to convergence < 3s; incremental re-layout after 10-node delta < 100ms; main thread never blocked > 4ms (asserted via worker boundary) |
| UI verification | SVG snapshots reviewed by a human against the checklist (overlap %, label room, symmetry) |
| Architecture | `layout` imports `abstraction`/`graph-core` types only; no DOM outside the worker host shim |
| Manual exploratory | Layout the ugliest corpus fixtures; note pathologies into the tracker with SVGs attached |
| Failure cases | Provider crash inside worker (host recovers, falls back to grid); zero-size nodes; disconnected components; cancellation storm |
| Regression | P0–P3 suites; SVG goldens locked |

**13. Definition of Done.** Phase gate passes; a reviewer can judge layout
quality for any fixture from CI artifacts alone (SVGs uploaded per run).

---

### Phase 5 — Renderer & app shell (first pixels)

**1. Goal.** `@meridian/renderer` (pixi v8): draw a laid-out cut with viewport
culling, instanced nodes, LOD-batched labels, hover/selection picking, and a
geometric (not yet semantic) camera — inside `apps/studio`, the React shell
that will host everything else. 10k nodes, 60fps pan/zoom, on commodity
hardware.

**2. Motivation.** Everything before this was verifiable headless; this
phase retires the GPU/perf risk and creates the product surface. Keeping the
camera *geometric* here is deliberate scope control: P6 owns semantics.

**3. Deliverables.** `renderer` (scene graph: node quads via instancing,
SDF/BitmapText labels with zoom-dependent visibility tiers, edge lines,
pick buffer or spatial-index picking, quadtree culling); `view-model`
(the pure function `(snapshot, lodResult, layoutResult, selection) →
RenderModel` — the only thing the renderer reads); `apps/studio` (Vite +
React chrome: file open, adapter pick via sniff, side panel showing selected
node's attrs + provenance, zustand store); FPS/heap HUD behind a debug flag.

**4. Components introduced.** `renderer`, `view-model`, `studio`;
Playwright infrastructure.

**5. Interfaces that should exist.**

```ts
interface SceneAdapter {                      // the pixi-replaceability seam
  mount(canvas: HTMLCanvasElement): void;
  render(model: RenderModel, camera: CameraState): void;
  pick(screen: Point): PickResult | null;
  destroy(): void;
}
interface CameraController {                  // geometric only, this phase
  state(): CameraState;                       // center, scale
  panBy(d: Vec2): void; zoomAt(screen: Point, factor: number): void;
  on(evt: 'change', cb: (s: CameraState) => void): Unsubscribe;
}
```

**6. Public APIs.** `createScene(canvas, opts)`, `buildRenderModel(...)`
(pure, unit-testable), selection/hover event streams consumed by React via
zustand; Studio itself is an app, not an API.

**7. Data structures.** `RenderModel` (flat typed-array-friendly arrays:
positions, sizes, colorIds, labelRefs, edgeIndex pairs — designed for
instanced upload, not object graphs); `CameraState { center, scale }`;
`PickResult { nodeId | edgeId, screen, world }`.

**8. Technical decisions that must be finalized (ADRs).**
- **ADR-0019 pixi v8 behind `SceneAdapter`**; explicit list of pixi APIs
  allowed (keeps the seam honest).
- **ADR-0020 Label strategy:** BitmapText meridian + zoom-tiered visibility
  (labels are the classic graph-render perf killer; the tier function is
  spec'd and tested).
- **ADR-0021 Picking approach** (GPU pick buffer vs quadtree hit-test —
  decide on measured numbers; quadtree favored for simplicity).
- **ADR-0022 React/canvas boundary:** React never issues draw calls; canvas
  never touches React state except through the zustand store.

**9. Risks.** (a) 60fps @10k with labels — the phase's raison d'être;
attacked with instancing + culling + label tiers, measured by an automated
FPS test, with the ADR-0014 node budget as the ultimate backstop.
(b) Pixel-test flakiness — mitigated: software-rendering CI profile,
tolerance-banded diffs, deterministic fixture + camera scripts.
(c) Studio scope creep — chrome is deliberately ugly-but-functional; design
polish is not a phase objective.

**10. Intentionally deferred.** Semantic zoom (P6), animations/transitions
(P6), alternative projections (P10), WebGPU path (pixi flag flip later),
minimap (P6), theming.

**11. Acceptance criteria.** Studio opens any corpus file end-to-end
(ingest → cut → layout → render); pan/zoom at 60fps on the 10k fixture
(automated FPS sampler ≥ 55fps p95); hover/select round-trips to the side
panel < 16ms; culling verified (draw calls drop as you zoom in — asserted
via renderer stats).

**12. Verification required before Phase 6.**

| Category | This phase |
|---|---|
| Unit | `buildRenderModel` (pure); camera math; label tier function; quadtree |
| Integration | Studio boot → ingest → render smoke via Playwright on every corpus |
| Performance | Automated: p95 frame time ≤ 18ms during scripted pan/zoom on 10k fixture; first-render < 1s from layout-ready; heap stable over 5-min soak (no leak) |
| UI verification | Playwright screenshot baselines per corpus at 3 zoom scales; interaction scripts (hover shows label, click selects, panel populates) |
| Architecture | React components may not import pixi; `renderer` may not import `graph-store` (only `view-model` output); depcruise enforced |
| Manual exploratory | Trackpad vs mouse-wheel feel; hi-DPI; browser zoom; resize; dark room jank check |
| Failure cases | WebGL context loss (auto-restore); zero-node graph; NaN positions from a hostile layout result (clamped + warned, not white-screen) |
| Regression | Full prior suite; screenshot goldens locked |

**13. Definition of Done.** Phase gate passes; the FPS test is a permanent
CI gate; demo recording committed under `docs/meridian/demos/`.

---

### Phase 6 — Semantic zoom & navigation — closes M2

**1. Goal.** Fuse the P3 resolver with the P5 camera into the signature
experience: continuous zoom that *changes abstraction*, Maps-style — anchor
point stays put, outgoing cut cross-fades into the incoming cut, positions
interpolate along refinement mappings — plus drill-in/out, breadcrumbs,
search-and-fly-to, and expand/collapse-in-place.

**2. Motivation.** This is the product's thesis made tangible, and the moment
the "zooming changes the abstraction itself" claim becomes demonstrable and
falsifiable. Everything it composes already exists and is tested; this phase
is about *choreography and feel*, which is why it gets its own gate rather
than being folded into P5.

**3. Deliverables.** `@meridian/navigation`: `NavigationController` (owns zoom
scalar ↔ LodRequest, hysteresis, override map), `TransitionChoreographer`
(cut-diff → enter/exit/move sets → animation plan), anchor-preservation math,
drill-in (enter a node's `detail` graph as a new context), breadcrumb model,
search (P1 label-token index) with fly-to, keyboard navigation; Studio:
breadcrumb bar, search box, minimap.

**4. Components introduced.** `navigation`; Studio grows its navigation
chrome.

**5. Interfaces that should exist.**

```ts
interface NavigationController {
  zoomTo(z: number, anchor: Point): void;        // may trigger cut change
  drillInto(id: NodeId): void; drillOut(): void;
  expand(id: NodeId): void; collapse(id: NodeId): void;   // ADR-0012 overrides
  flyTo(id: NodeId): void;
  context(): NavContext;                         // breadcrumb trail, current levels
  on(evt: 'cutchange' | 'context', cb): Unsubscribe;
}
interface TransitionChoreographer {
  plan(from: {cut, layout}, to: {cut, layout}, refinements: RefinementMap): TransitionPlan;
}
interface TransitionPlan { enter: NodeAnim[]; exit: NodeAnim[]; move: NodeAnim[]; durationMs: number; }
```

**6. Public APIs.** The controller above (consumed by Studio and, later, by
collaboration presence in P12); URL state serialization
(`#g=…&z=…&focus=…`) so any view is linkable — cheap now, load-bearing for
P12 sessions.

**7. Data structures.** `RefinementMap` (abstract node → its detail nodes —
derivable from containment; the interpolation table), `NavContext`
(stack of `{graphId, cutLevel, camera}`), `TransitionPlan` above.

**8. Technical decisions that must be finalized (ADRs).**
- **ADR-0023 Transition model:** children spawn from parent's rect and
  cross-fade (in) / merge into parent (out); moved nodes tween; one shared
  easing; hard budget — a transition never exceeds 300ms or drops below
  45fps (it degrades to a plain cross-fade first).
- **ADR-0024 Anchor rule:** the world point under the cursor at
  threshold-crossing maps through the refinement to stay under the cursor —
  the single rule that makes it feel like Maps.
- **ADR-0025 Drill-in vs zoom:** continuous zoom moves the *cut*; explicit
  drill-in (dblclick/enter) *changes context* to the detail graph. Both
  exist; this ADR fixes when each triggers, ending an otherwise eternal
  design debate.

**9. Risks.** (a) Feel — mitigated by making the choreographer a pure,
unit-testable planner (feel bugs become inspectable plans) and by an
explicit manual-exploration budget with tunable constants in a debug panel.
(b) Thrash at thresholds — hysteresis from ADR-0012, now tuned with real
input devices. (c) Layout instability sabotaging transitions — the P4
stability score becomes a hard gate for providers used under zoom.

**10. Intentionally deferred.** Multiple simultaneous foci, split view,
view projections (P10), collaborative cursors (P12), zoom-dependent edge
bundling.

**11. Acceptance criteria.** Scripted zoom descent markdown-book→sentences
never drops below 45fps and never loses the anchor (automated: anchor pixel
drift < 8px across each transition); hysteresis verified (oscillating input
at a threshold causes zero cut-flaps); URL round-trips restore the exact
view; breadcrumbs always truthful (property: context stack ≡ replay of nav
events).

**12. Verification required before Phase 7 track-merge / M2 signoff.**

| Category | This phase |
|---|---|
| Unit | Choreographer plans for hand-built cut diffs; anchor math; hysteresis state machine; URL codec |
| Integration | Playwright scripted descents/ascents on 3 corpora; drill-in/out stack integrity |
| Performance | Transition p95 frame time ≤ 22ms; plan computation < 20ms on 5k-node cut diffs |
| UI verification | Screenshot baselines mid-transition (deterministic clock injected); visual continuity review from recordings |
| Architecture | `navigation` imports `abstraction`+`view-model`, never pixi directly |
| Manual exploratory | The "grandmother test": someone uninvolved zooms a book unprompted — do they understand what's happening? Notes filed |
| Failure cases | Zoom during in-flight transition (must retarget, not queue); drill into node with no detail; store mutation mid-transition (P1 subscription forces replan) |
| Regression | Everything prior; new interaction goldens |

**13. Definition of Done.** Phase gate passes; **M2 review**: recorded demo
of the book descent + live walkthrough; constants tuned and frozen into
defaults; `docs/meridian/demos/m2.md` script committed.

---

### Phase 7 — Source-code domain adapter (runs parallel to Phases 4–6)

**1. Goal.** The first *hard* domain: `adapters/code` ingests a real
repository into the full level chain — project → package → module →
class/function → control-flow → AST — deterministically, incrementally
(file change → `GraphDelta`, not re-ingest), for TypeScript and Python
first.

**2. Motivation.** Source code is the domain most likely to break the model:
deep recursion, dense cross-links (imports, calls), huge scale, and constant
change. Surviving it validates ADR-0001/0002 (flat space + stable IDs),
the P1 delta machinery, and the P3 level chains against reality — and it
produces the graph corpus that P8's AI work will be judged on. It runs on
the domain track in parallel with the visual track because it is developed
and verified entirely headless.

**3. Deliverables.** `adapters/code` on web-tree-sitter (WASM grammars for
TS + Python vendored under the package); mapping rules per level; import
graph + syntactic call graph (same-file/same-module resolution; explicitly
*not* type-aware); CFG builder for function bodies; AST-level graphs built
**lazily on drill-in** (an AST for every function up front would explode the
space — the `IngestSink` contract already permits deferred `detail`
materialization via a `DetailResolver` capability added to `plugin-api`);
watch mode: file change → incremental re-parse → minimal delta; conformance
+ a new *incremental* conformance suite (edit scripts with expected minimal
deltas).

**4. Components introduced.** `adapters/code`; `DetailResolver` (lazy
subgraph materialization — also exactly what P11's persistence needs, so it
is proven here first); parse workers.

**5. Interfaces that should exist.**

```ts
interface DetailResolver {                        // plugin-api addition (minor version)
  canResolve(node: SemanticNode): boolean;
  resolve(node: SemanticNode, sink: IngestSink): Promise<GraphRef>;  // materialize on demand
}
interface IncrementalAdapter extends DomainAdapter {
  update(change: SourceChange, sink: IngestSink): Promise<void>;     // file-level diff in, delta out
}
```

**6. Public APIs.** `meridian ingest ./repo --adapter code`,
`meridian watch ./repo`; adapter options (include/exclude globs, language
allowlist, laziness threshold).

**7. Data structures.** Node kinds `code:project|package|module|class|function|block|stmt|expr`;
edge kinds `code:imports|calls|contains|reads|writes|flows-to`; stable IDs
per ADR-0002 from `(path, qualifiedName, overloadHash)` so a whitespace-only
edit yields an *empty* delta (that is a test); `SourceChange { path, oldText?, newText? }`.

**8. Technical decisions that must be finalized (ADRs).**
- **ADR-0026 Resolution depth:** syntactic + import-graph only; no type
  checker. Revisit-criteria written down (e.g. call-graph precision proves
  too low for useful module-level induced edges).
- **ADR-0027 Laziness policy:** which levels are eager (project→function
  signatures) vs lazy (CFG, AST), and the size thresholds.
- **ADR-0028 ID stability under edits:** rename detection is *not* attempted
  in v1 (a rename = remove+add); alias-table mechanism reserved.

**9. Risks.** (a) Scale — a 100k-LOC repo at eager-AST would be millions of
nodes; laziness (ADR-0027) is the mitigation and its budgets are gates.
(b) Grammar/WASM operational pain across Node+browser — contained by loading
grammars through one shim with its own tests. (c) Call-graph precision
disappointment — expectations set in ADR-0026; edges carry
`confidence: 'syntactic'` so the UI can be honest.

**10. Intentionally deferred.** Type-aware resolution, more languages
(each later language is a plugin-sized task, not a phase), semantic diffing
beyond tree-sitter's incremental parse, cross-repo graphs, git-history
ingestion (a future adapter of its own).

**11. Acceptance criteria.** Ingest of a pinned real OSS repo (~100k LOC)
< 30s cold on reference hardware, byte-deterministic across runs; whitespace
edit → empty delta; single-function edit → delta touching only that
function's subtree (asserted op-count); drill into any function materializes
CFG/AST < 150ms; conformance + incremental conformance green.

**12. Verification required before Phase 8.**

| Category | This phase |
|---|---|
| Unit | Per-construct mapping rules (each language feature → expected nodes/edges); ID stability functions; CFG builder vs hand-drawn truth for tricky control flow |
| Integration | Golden graphs for a pinned fixture repo at each eager level; watch-mode edit scripts → golden deltas; full pipeline into P3 cuts (module cut of the fixture repo is a golden) |
| Performance | Cold ingest budget above; incremental file edit → applied delta < 100ms p95; lazy AST resolve < 150ms |
| UI verification | (Once P6 lands) Playwright: zoom the fixture repo project→AST; screenshot goldens at module + function levels |
| Architecture | Core/`abstraction` still contain no `code:` strings (grep gate); grammars only loaded in workers |
| Manual exploratory | Load *this project's own monorepo*; navigate to a known function; judge whether every level "reads" truthfully |
| Failure cases | Syntax-error files (error-tolerant parse still yields partial graph, flagged), symlink cycles, 10MB generated file (excluded by budget policy), grammar load failure |
| Regression | All prior; repo goldens pinned to a fixture commit hash |

**13. Definition of Done.** Phase gate passes; dogfood target achieved: Meridian
renders Meridian. The combined M2+P7 demo (zoom real code to AST) is recorded.

---

### Phase 8 — AI reasoning layer

**1. Goal.** `@meridian/ai` + `@meridian/ai-services`: a provider-agnostic AI
gateway (completion + embeddings) with caching, budgeting, structured-output
validation, and record/replay determinism — and the first three AI services,
each implementing an *already-existing* interface: `SummarizingAbstractionProvider`
(names + summaries for rollup nodes), `EmbeddingClusterer` (semantic grouping
of flat node sets), `StructureExtractor` (unstructured text → graph
proposal, the enabler for P9).

**2. Motivation.** AI is the product's differentiator and its biggest
operational liability (cost, latency, nondeterminism, garbage output). The
architecture keeps it *optional at the interface level* — every AI service
implements a P2/P3 interface that already has deterministic implementations,
and AI output enters the graph only through ordinary P1 deltas tagged
`origin: 'ai'`. This phase builds the discipline (caching, evals, budgets)
before AI-dependent domains (P9) can amplify any sloppiness.

**3. Deliverables.**
- `ai`: `AiProvider` interface; Anthropic implementation
  (`claude-opus-4-8` default for extraction/summarization,
  `claude-haiku-4-5` for bulk short labels; structured outputs via
  `output_config.format` with zod schemas; prompt caching for the shared
  graph-context prefix; Batches API path for whole-corpus jobs);
  content-hash response cache (durable, doubles as the record/replay
  fixture store for CI); `BudgetGuard` (per-session token/dollar ceilings,
  hard-fail behavior); rate-limit/backoff handling via SDK.
- `ai-services`: the three services above, each emitting `AbstractionProposal`s
  / `GraphDelta`s with confidence + rationale attrs.
- `evals/`: offline eval harness — scored fixtures (e.g. human-rated module
  summaries), run on demand and on model/prompt changes, *not* on every CI
  run.
- Studio: AI-origin nodes visually distinct; accept/reject flow for
  proposals (human-in-the-loop is the default, auto-accept is opt-in).

**4. Components introduced.** `ai`, `ai-services`, `evals`; the
`ai-provider` plugin capability (so other vendors/local models are plugins).

**5. Interfaces that should exist.**

```ts
interface AiProvider {
  complete(req: CompletionRequest): Promise<CompletionResult>;   // structured-output aware
  embed(texts: string[]): Promise<Float32Array[]>;
  readonly modelInfo: ModelInfo;
}
interface AiSession {                              // what services actually consume
  call<T>(prompt: PromptSpec, schema: ZodType<T>): Promise<AiResult<T>>;  // cache→budget→provider→validate
  budget(): BudgetState;
}
// Services implement existing seams:
class SummarizingAbstractionProvider implements AbstractionProvider { … }
interface StructureExtractor { extract(text: string, domainHints: DomainHints): Promise<GraphProposal>; }
```

**6. Public APIs.** `createAiSession(config)`, `summarizeCut(store, cut)`,
`clusterNodes(store, graphId, opts)`, `extractStructure(text, hints)`; CLI
`meridian ai summarize|cluster --budget 2.00`; env-based key config, never
persisted into graph documents.

**7. Data structures.** `PromptSpec` (template id + params — prompts are
versioned files, not string literals, so evals can pin them); `AiResult<T>`
(`{ value: T; usage; cached: boolean; model; promptVersion }`);
AI provenance on every derived node/edge:
`SourceRef { origin: 'ai', model, promptVersion, inputHash, confidence }` —
already modeled in P0, populated for real now; `BudgetState`.

**8. Technical decisions that must be finalized (ADRs).**
- **ADR-0029 Provider + models:** Anthropic default with the model split
  above; every graph-shaped output uses structured outputs; Batches for
  corpus jobs; the `AiProvider` seam is the commitment, the vendor is config.
- **ADR-0030 Determinism strategy:** CI never calls the network — the
  content-hash cache is committed as fixtures (record locally/nightly,
  replay in CI); a cache miss in CI is a *test failure*, not a live call.
- **ADR-0031 Trust & provenance policy:** AI never mutates the graph
  directly; it emits proposals → deltas tagged `origin:'ai'`; UI must always
  be able to filter/highlight AI-derived structure; auto-accept only via
  explicit per-source setting.
- **ADR-0032 Budget policy:** defaults, hard-stop semantics, and what the
  user sees when a budget trips mid-operation (partial results kept,
  clearly marked).

**9. Risks.** (a) Garbage output — structured outputs + zod + schema-level
repair-then-reject; malformed-output fuzz tests. (b) Cost surprises —
BudgetGuard is not optional; Batches + Haiku for bulk; prompt caching for
the big shared context. (c) Eval subjectivity — small human-rated golden
sets with rubric, trend-tracked, not gate-blocking except for regressions
below a floor. (d) Vendor coupling — the capability seam + a `MockProvider`
that every test can run against.

**10. Intentionally deferred.** Fine-tuning, local models (a future
`ai-provider` plugin), agentic multi-step extraction loops, AI-driven layout
hints, auto-accept by default.

**11. Acceptance criteria.** All AI paths run green in CI with zero network
(replay mode proven by running CI with network disabled); summaries appear
on the P7 repo's module cut with correct provenance and are filterable;
clusterer turns a 500-node flat soup into labeled groups that pass the eval
floor; budget trip mid-run leaves a valid, partially-enriched graph.

**12. Verification required before Phase 9.**

| Category | This phase |
|---|---|
| Unit | Cache keying (prompt version + input hash); BudgetGuard state machine; zod rejection paths; PromptSpec rendering |
| Integration | Record/replay end-to-end: `meridian ai summarize` over the fixture repo replayed in CI; proposals → store → cut pipeline |
| Performance | Replay-mode overhead < 5ms/call; embedding + clustering of 5k nodes < 10s (live, nightly); UI never blocks on AI (all async, cancellable) |
| UI verification | Playwright: AI badge rendering, filter toggle, accept/reject flow |
| Architecture | Only `ai` imports the Anthropic SDK (depcruise); `ai-services` depends on `ai` + core seams only |
| Manual exploratory | Read 20 AI module summaries against the actual code; rate them; file prompt issues |
| Failure cases | Provider 429/529 (backoff, then budget-aware give-up), refusal stop-reason, schema-invalid response (one repair attempt → reject + mark node), network loss mid-batch, budget exhaustion |
| Regression | All prior; recorded AI fixtures locked with prompt versions |

**13. Definition of Done.** Phase gate passes; eval harness documented and
runnable by anyone with a key; a cost table (¢ per 1k nodes summarized,
measured) is committed to the docs.

---

### Phase 9 — AI-native domains: conversations & arguments — closes M3

**1. Goal.** Two adapters that *cannot exist without P8*:
`adapters/conversation` (LLM chat exports → topics → exchanges → messages →
claims) and `adapters/argument` (essays/debates → claims, premises,
objections with typed `supports`/`rebuts`/`assumes` edges). Then, with three
structurally different domains live (tree-ish markdown, dense-graph code,
AI-extracted discourse), **freeze `plugin-api` at 1.0**.

**2. Motivation.** These domains prove the two claims still unproven: that
the plugin contract generalizes beyond parseable syntax (rule of three), and
that AI-extracted structure flows through the *same* pipeline as parsed
structure — same proposals, same deltas, same provenance, same zoom. They
also deliver the most demo-able artifact for non-programmers: zooming a
conversation.

**3. Deliverables.** Both adapters (conversation: deterministic
message/thread skeleton parsed from export formats — Claude/ChatGPT JSON —
with AI layering topics/claims on top; argument: `StructureExtractor`-driven
with a deterministic paragraph/sentence fallback skeleton so the adapter
still works AI-less, degraded); level-chain specs for both domains;
corpus + goldens (recorded AI fixtures); plugin-api 1.0 freeze + migration
notes; plugin author guide v1 published in-repo.

**4. Components introduced.** `adapters/conversation`, `adapters/argument`;
the API-freeze process itself (api-extractor snapshot becomes a 1.0
contract).

**5. Interfaces that should exist.** No new core interfaces — that is the
point. The phase report must list every place the existing contract chafed;
each item is either fixed pre-freeze or explicitly deferred with rationale.

**6. Public APIs.** `meridian ingest chat-export.json --adapter conversation`;
`meridian ingest essay.md --adapter argument`; plugin-api 1.0 (semver-guarded
by api-extractor snapshot in CI).

**7. Data structures.** Node kinds `conv:session|topic|exchange|message|claim`,
`arg:thesis|claim|premise|objection|evidence`; edge kinds
`conv:replies-to|refers-back|about`, `arg:supports|rebuts|assumes|cites`;
both level chains registered via manifests.

**8. Technical decisions that must be finalized (ADRs).**
- **ADR-0033 plugin-api 1.0 scope:** exactly which types are frozen, the
  deprecation policy, and the additive-only rule until 2.0.
- **ADR-0034 Hybrid adapters pattern:** deterministic skeleton + AI
  enrichment as separate, individually-cacheable passes (the pattern both
  adapters share; documented as *the* recommended shape for future AI-native
  adapters).

**9. Risks.** (a) Extraction quality on argumentative text is genuinely hard
— scope: claim/support extraction at "useful, clearly-provenance-marked"
quality, with eval floors, not scholarly-grade argument mining. (b) Freezing
the API too early with un-chafed corners — mitigated by the mandatory chafe
report in §5. (c) Export-format drift (Claude/ChatGPT JSON) — format
adapters isolated behind tiny per-format parsers with their own fixtures.

**10. Intentionally deferred.** Live conversation ingestion (streaming from
an API session), multi-document argument corpora, cross-domain linking
(e.g. conversation message ↔ code node — a P12+ platform feature),
scholarly argumentation schemes.

**11. Acceptance criteria.** Both adapters pass conformance; a real exported
conversation zooms topics→messages in Studio with AI topic labels; argument
map of a known essay is judged faithful against a human-made reference map
(eval fixture); plugin-api 1.0 tagged; the toy-adapter exercise from P2
re-run against 1.0 docs by a fresh person in < 1 hour.

**12. Verification required before Phase 10.**

| Category | This phase |
|---|---|
| Unit | Export-format parsers; skeleton builders; enrichment merge logic (AI pass re-run must not duplicate nodes — idempotent by inputHash) |
| Integration | Full ingest→zoom goldens for both domains (replayed AI); conformance suite ×2 |
| Performance | 1k-message conversation ingest (skeleton) < 3s; AI enrichment pass batched + budgeted; UI responsive throughout |
| UI verification | Playwright zoom descents on both domains; AI-provenance filtering |
| Architecture | api-extractor 1.0 snapshot gate live; adapters isolated as ever |
| Manual exploratory | Ingest a real personal conversation; judge topic labels; ingest an op-ed; judge the argument map against your own reading |
| Failure cases | Truncated/hand-edited exports; conversation with one message; AI unavailable → degraded-but-working skeleton mode (explicit test) |
| Regression | All prior suites + goldens |

**13. Definition of Done.** Phase gate passes; **M3 review**: three-domain
demo recorded (`docs/meridian/demos/m3.md`); plugin-api 1.0 tag cut; chafe
report resolved.

---

### Phase 10 — View projections (multiple visualization modes)

**1. Goal.** Generalize "the map" into `ViewProjection`: the same
`(snapshot, cut, selection)` renders as node-link map (existing), outline
tree, adjacency matrix, or timeline/swimlane — switchable live, with
selection, focus, and (where meaningful) camera semantics preserved across
switches.

**2. Motivation.** "Different visualization modes generated from the same
underlying representation" is a founding requirement; doing it *after* the
map is complete (rather than speculatively earlier) means the abstraction is
extracted from a working exemplar instead of invented. This phase also
flushes out any accidental map-assumptions that leaked into navigation or
view-model — cheaper to fix now than under P11's scale work.

**3. Deliverables.** `@meridian/projections`: the `ViewProjection` interface;
refactor of the P5/P6 map into `MapProjection` (behavior-identical —
locked by existing goldens); `OutlineProjection` (virtualized DOM tree —
not canvas; projections choose their medium), `MatrixProjection` (canvas,
cluster-ordered), `TimelineProjection` (for domains with temporal attrs —
conversations, later git history); Studio mode switcher; per-projection
persistence of view state; `view-projection` plugin capability goes live.

**4. Components introduced.** `projections`; second render medium (DOM)
proving the view-model is genuinely presentation-neutral.

**5. Interfaces that should exist.**

```ts
interface ViewProjection {
  readonly id: string;
  suitability(cut: Cut, meta: DomainMeta): number;      // 0..1 — drives the mode menu ordering
  mount(host: ProjectionHost): ProjectionInstance;
}
interface ProjectionInstance {
  render(model: ProjectionModel): void;                  // ProjectionModel ⊇ RenderModel inputs
  applySelection(sel: Selection): void;
  captureViewState(): unknown; restoreViewState(s: unknown): void;
  destroy(): void;
}
```

**6. Public APIs.** Projection registration via plugin-api; Studio
`switchProjection(id)`; shared `Selection`/`Focus` model formalized (it was
implicit in zustand until now — this phase names it).

**7. Data structures.** `ProjectionModel` (cut + induced edges + attrs +
level context + optional layout — layout becomes *optional* input, since
outline/matrix don't need it); `Selection { nodes: Set<NodeId>, anchor?: NodeId }`
shared across all projections.

**8. Technical decisions that must be finalized (ADRs).**
- **ADR-0035 What survives a mode switch:** selection + focus node always;
  camera only where geometrically meaningful (map↔map); scroll position maps
  to focus-node visibility elsewhere. Written down so every future
  projection has a rule to follow.
- **ADR-0036 Projections own their medium** (canvas vs DOM) behind
  `ProjectionHost`; the host provides the container, input plumbing, and the
  store — nothing else.

**9. Risks.** (a) The map refactor regresses feel — mitigated: it is gated
by the *entire* existing P5/P6 golden + FPS suite passing unchanged.
(b) Matrix/timeline become mini-products — scoped to read-only v1s with
explicit non-goals lists. (c) Selection model unification uncovers implicit
coupling — that's the phase working as intended; budgeted for.

**10. Intentionally deferred.** User-composed dashboards (multiple
simultaneous projections), 3D, editable projections (outline as an editor),
projection-specific plugins beyond the four built-ins.

**11. Acceptance criteria.** All four projections work on all three domains
(where applicable — timeline requires temporal attrs and must *degrade with
a message*, not crash); switching preserves state per ADR-0035 (property
test over random switch sequences); map goldens byte-identical post-refactor.

**12. Verification required before Phase 11.**

| Category | This phase |
|---|---|
| Unit | suitability functions; view-state capture/restore round-trips; matrix ordering; outline virtualization windowing |
| Integration | Mode-switch matrix (4 projections × 3 domains) via Playwright; selection-survival property scripts |
| Performance | Outline virtualized to 100k rows scrolls at 60fps; matrix 2k×2k renders < 500ms; switch itself < 200ms |
| UI verification | Screenshot baselines per projection × domain; keyboard nav in outline |
| Architecture | Projections import `view-model`/`abstraction`, never `graph-store` write paths; map projection passes pre-refactor goldens |
| Manual exploratory | Real tasks in wrong-looking modes ("find the dense module in matrix", "skim the argument in outline") — friction notes |
| Failure cases | Switch mid-transition; projection instance throwing on mount (host contains, falls back to map); timeline on atemporal domain |
| Regression | Entire prior suite — especially P5/P6 goldens unchanged |

**13. Definition of Done.** Phase gate passes; a projection-author guide
section added to the plugin docs (the capability is public API now).

---

### Phase 11 — Scale, persistence & incremental hardening

**1. Goal.** Raise the ceilings and make them contractual: 500k nodes
*stored*, 50k *renderable working set*, persistent storage (SQLite) with
lazy per-graph hydration behind the unchanged `GraphStore` interface,
streaming ingestion for huge sources, and end-to-end incremental flow —
file edit → delta → cut update → layout patch → re-render — in under a
second. Every number becomes a CI-gated benchmark.

**2. Motivation.** Scale work done speculatively is waste; scale work done
too late is a rewrite. By now real usage (the Meridian-on-Meridian dogfood, a
monorepo, long conversations) tells us exactly where the cliffs are. The
persistence backend also creates the durability layer P12's sync log
requires.

**3. Deliverables.** `@meridian/store-sqlite` (better-sqlite3 in Node,
wa-sqlite/OPFS in browser; schema: graphs, nodes, edges, ops-log, indices;
`DetailResolver`-style lazy hydration of subgraphs on drill-in); streaming
ingestion (adapters already emit deltas — the store now applies them in
bounded-memory batches with progress); incremental pipeline plumbing
(ChangeSet → affected-cut diff → layout patch → render patch, each stage
already existed, now wired and measured end-to-end); memory budgets +
eviction of hydrated-but-unviewed subgraphs; `benchmarks/` promoted to a
first-class suite with a tracked dashboard artifact per CI run; profiling
docs.

**4. Components introduced.** `store-sqlite`; benchmark dashboard;
(only if benchmarks demand it, per ADR) a WASM hot-path — this is the
pre-agreed decision point for that, not earlier.

**5. Interfaces that should exist.** None new by design —
`GraphStore` gains a `StorageBackend` constructor parameter:

```ts
interface StorageBackend {
  loadGraph(id: GraphId): Promise<SemanticGraph | null>;
  persist(change: ChangeSet): Promise<void>;            // called post-commit, async
  appendOps(delta: GraphDelta): Promise<void>;          // durable op log (P12 substrate)
  evictHint(ids: GraphId[]): void;
}
```

**6. Public APIs.** `createStore(space, { backend })`;
`meridian open <project.meridian-db>`; `meridian bench` (runs the suite locally
against the thresholds).

**7. Data structures.** SQLite schema (versioned, migration hooks per
ADR-0004); hydration state per graph (`cold | hydrating | live | evictable`);
benchmark manifest (`benchmarks/budgets.json` — the single file where every
performance promise in this roadmap lives, reviewed like code).

**8. Technical decisions that must be finalized (ADRs).**
- **ADR-0037 SQLite as the embedded store** (vs LMDB/IndexedDB-raw/custom);
  OPFS strategy in browser; single-writer assumption documented (multi-writer
  is P12's server, not the embedded store).
- **ADR-0038 Hydration & eviction policy** (what triggers load, what may be
  dropped, interaction with undo history).
- **ADR-0039 WASM go/no-go:** the measured criteria under which a hot path
  (likely induced-edge aggregation or layout) gets a Rust/WASM port — and
  the decision made from this phase's numbers.

**9. Risks.** (a) OPFS/wa-sqlite browser maturity — fallback path: in-memory
+ document export remains fully supported (persistence is an enhancement,
not a new requirement for correctness). (b) Incremental pipeline correctness
under rapid-fire edits — property test: any interleaving of edits eventually
converges to the from-scratch result (I6 extended). (c) Benchmark hardware
variance in CI — pinned runner class + relative-regression gating (±15%)
alongside absolute budgets.

**10. Intentionally deferred.** Server-side storage (P12), multi-writer,
sharding, GPU layout, >1M-node ambitions (explicitly re-scoped when a real
need appears).

**11. Acceptance criteria.** The pinned ~1M-LOC monorepo ingests streamed
(bounded memory, progress UI), opens from cold `.meridian-db` < 3s to first
interactive cut, zooms fluidly; file edit propagates to pixels < 1s p95;
kill -9 during ingest → reopen recovers to a consistent version (op log
replay); all budgets in `budgets.json` green.

**12. Verification required before Phase 12.**

| Category | This phase |
|---|---|
| Unit | Backend CRUD + migration; hydration state machine; eviction vs undo interactions |
| Integration | Cold-open, crash-recovery, and edit-propagation scenarios scripted end-to-end; browser (OPFS) and Node (file) parity suite |
| Performance | The whole `budgets.json`: ingest throughput (nodes/s), cold open, edit→pixel p95, memory ceiling under soak, eviction effectiveness |
| UI verification | Playwright on the monorepo fixture: responsiveness during background ingest; progress UI |
| Architecture | `store-sqlite` is the only package importing sqlite bindings; `GraphStore` interface unchanged (api-extractor proves it) |
| Manual exploratory | A full working session on the monorepo: open, navigate, edit files externally, watch updates; note any jank |
| Failure cases | Disk full, corrupted db (detected, refuses with message, offers export), OPFS unavailable (clean fallback), edit storm (100 edits/s coalesced) |
| Regression | Everything — this phase is highest-regression-risk; the full golden corpus must pass against the sqlite backend too |

**13. Definition of Done.** Phase gate passes; benchmark dashboard is part
of every CI run; ADR-0039 decided with data.

---

### Phase 12 — Collaboration & platform — closes M4

**1. Goal.** Turn the application into a platform: (a) real-time
collaboration — a sync service replicating the P1/P11 op log with
server-authoritative ordering, presence (cursors, cameras, selections), and
shared sessions; (b) a plugin ecosystem posture — registry manifest format,
semver + conformance gating for third-party plugins, worker-isolated plugin
execution, and a public SDK docs site.

**2. Motivation.** Both halves are harvests of seeds planted early:
collaboration is possible *without touching the mutation model* because
every write has been an invertible, versioned op since Phase 1; the plugin
ecosystem is possible because the API froze at 1.0 with a conformance kit in
Phase 9. This phase proves the roadmap's central bet — that platform
qualities are architectural properties, not features.

**3. Deliverables.** `sync-protocol` (wire types: hello/subscribe/ops/ack/
presence, shared client↔server); `services/sync` (Node + WebSocket:
per-session op sequencer over the P11 durable log, auth hook left as an
integration point, presence fan-out); client sync engine in `graph-store`
(optimistic local apply → server rebase — rebase is tractable because ops
carry `prev` and the server orders); Studio: presence layer (avatars,
live cursors mapped through each peer's projection, camera-follow mode),
conflict toasts for the rare true conflict (attr-level last-writer-wins with
history retained in the op log); plugin platform: registry manifest schema +
`meridian plugins add <tarball|url>` with signature + conformance-run gate,
worker-based plugin isolation (the ADR-0009 payoff), docs site
(`apps/docs-site`) generated from plugin-api + guides.

**4. Components introduced.** `sync-protocol`, `services/sync`, docs site;
the project's first server-side deployable (containerized; deployment
recipes documented, orchestration out of scope).

**5. Interfaces that should exist.**

```ts
interface SyncTransport { send(msg: SyncMsg): void; on(cb: (msg: SyncMsg) => void): Unsubscribe; }
interface SyncEngine {                            // client side, wraps a GraphStore
  status(): 'offline' | 'syncing' | 'live';
  presence(): ReadonlyMap<PeerId, PeerPresence>;
  publishPresence(p: LocalPresence): void;
}
interface PeerPresence { cursor?: WorldPoint; camera?: CameraState; selection?: Selection; projectionId: string; }
```

**6. Public APIs.** `connectSession(url, docId, auth)`; presence pub/sub;
`meridian serve` (dev sync server); plugin registry commands; the docs site is
the public API surface for third parties.

**7. Data structures.** `SyncMsg` union (versioned); server session state
(doc → sequenced op log offset + connected peers); rebase queue on the
client; registry manifest (`plugin name/version/apiVersion/hash/signature/
capabilities/permissions`).

**8. Technical decisions that must be finalized (ADRs).**
- **ADR-0040 Sync model:** server-authoritative op-log sequencing (chosen
  over CRDT per §6, revisited here against real requirements — the ADR must
  document the offline-editing consequence: offline is read-only + queued
  ops that rebase on reconnect, *not* full offline merge).
- **ADR-0041 Conflict policy:** structural ops are order-serialized by the
  server (no merge needed); concurrent attr writes = LWW + retained history;
  UI surfacing rules.
- **ADR-0042 Plugin trust model:** signed manifests, worker isolation,
  declared permissions (network? AI budget? filesystem?), what an installed
  plugin can never do.
- **ADR-0043 Docs/versioning of the public SDK** (site generation, versioned
  docs per plugin-api minor).

**9. Risks.** (a) Rebase edge cases — bounded by the op vocabulary being
small, versioned, and invertible; fuzz: N simulated clients × random op
streams × random partitions must converge (this simulator is a deliverable,
not an afterthought). (b) Presence noise at scale — throttled + interest-
scoped (only peers in your viewport region at full rate). (c) Third-party
plugin quality — the conformance gate is mechanical; curation policy is a
product decision documented, not solved, here. (d) Server operational
surface — kept minimal: one stateless-ish service over the durable log;
no accounts system in scope (auth is a hook).

**10. Intentionally deferred.** Full offline merge/CRDT (unless ADR-0040's
revisit flips it), comments/annotations layer, permissions/roles beyond
read-write, plugin marketplace UX (registry is manifest + CLI first),
mobile.

**11. Acceptance criteria.** Two browsers editing/navigating one document
converge (fuzz-verified 10k-op simulations, zero divergence); presence
feels live (< 250ms p95 end-to-end on LAN); disconnect/reconnect rebases
cleanly with queued local ops; a third-party demo plugin (built outside the
monorepo against published 1.0 types) installs via the registry flow, passes
conformance in the gate, runs isolated, and renders its domain; docs site
builds and covers the full authoring journey.

**12. Verification required for M4 signoff.**

| Category | This phase |
|---|---|
| Unit | Sequencer ordering; rebase transform per op pair; SyncMsg codec fuzz; manifest signature verification |
| Integration | Multi-client convergence simulator (the flagship test of this phase); Playwright two-browser-context live session; external-plugin install → conformance → run |
| Performance | Op round-trip < 100ms p95 LAN; 10-peer presence at 60fps client-side; server 1k ops/s/doc sustained |
| UI verification | Two-context Playwright: cursors visible, camera-follow, conflict toast; screenshot goldens |
| Architecture | `sync-protocol` shared with zero server-only deps leaking to client; plugins run with no direct store reference (capability-object only) |
| Manual exploratory | A real pair session: co-navigate a codebase for 30 minutes on two machines; note every confusion |
| Failure cases | Server death mid-session (clients queue, reconnect, rebase); malicious plugin (permission violations blocked + reported); clock skew; duplicate op delivery (idempotency) |
| Regression | Entire suite, all backends, all projections, all domains — the M4 full-matrix run |

**13. Definition of Done.** Phase gate passes; **M4 review**: the two-machine
collaboration demo and the external-plugin demo recorded; `docs/meridian/demos/m4.md`
committed; the roadmap's successor document (post-platform backlog) drafted.

---

## 9. Milestones

**M1 — Headless semantic core** (end of Phase 3).
*Exists:* the universal graph model, op-based mutation with undo, the plugin
contract with a conforming Markdown adapter, and a tested formalism for
semantic zoom — all driveable from a CLI, all property-tested, zero UI.
*Demonstrable:* ingest a book, mutate it, print any abstraction cut.
*Meaning:* the two irreversible bets (recursion representation, op-based
mutation) are locked and validated; parallel tracks may start.

**M2 — The zoomable map** (end of Phase 6).
*Exists:* layout engine, 60fps WebGL renderer, Meridian Studio, and true
semantic zoom with Maps-feel transitions, breadcrumbs, search, drill-in,
linkable views.
*Demonstrable:* the signature demo — zoom a document from chapters to
sentences, continuously.
*Meaning:* the product thesis is proven or falsified; everything after is
breadth and depth, not existence risk.

**M3 — Intelligent & multi-domain** (end of Phase 9).
*Exists:* a real code domain (incremental, lazy, dogfooding on Meridian
itself), the AI layer (deterministic in CI, budgeted, provenance-tagged),
conversation and argument domains, plugin-api 1.0.
*Demonstrable:* three structurally different domains zooming through
AI-labeled abstractions; Meridian rendering Meridian.
*Meaning:* generality and the AI operating discipline are proven; the
external-facing API is frozen.

**M4 — Platform** (end of Phase 12).
*Exists:* four view projections, contractual scale (500k stored / 50k
rendered / sub-second edit-to-pixel), durable storage, real-time
collaboration, isolated third-party plugins, public SDK docs.
*Demonstrable:* two people co-navigating a million-line codebase; a plugin
built outside the repo installing and running.
*Meaning:* Meridian is a platform, per the original brief.

---

## 10. Risk reduction ledger

How the sequencing itself manages risk — each phase retires a named
existential risk while it is still cheap:

| Risk (would kill or cripple the project) | Retired by | How |
|---|---|---|
| Recursion model can't support lazy loading / scale / cross-level edges | P0 | Flat GraphSpace + induced-edge rule decided first, under property tests, before any consumer exists to demand shortcuts |
| Incremental updates & multiplayer need a mutation-model rewrite | P1 | Op log with invertible ops is the *only* write path from the second phase onward |
| Domain logic osmoses into the core | P2 | Boundary exists while there's one adapter; mechanically enforced (depcruise + grep gates) forever after |
| "Semantic zoom" stays a metaphor instead of a mechanism | P3 | Cut formalism is a pure, tested function long before it has pixels |
| Layout quality/stability blocks the UX | P4 | Judged and gated via SVG goldens with no renderer entangled |
| WebGL perf ceiling | P5 | 10k@60fps is an automated CI gate, hit before feature weight accumulates |
| The signature interaction doesn't feel right | P6 | Isolated as pure choreography over proven parts; tunable, testable, human-gated |
| A hard real domain breaks the abstractions | P7 | Code domain stress-tests IDs, deltas, laziness, and levels — in parallel, headless, before M2 even finishes |
| AI is untestable, unaffordable, or untrusted | P8 | Record/replay CI, budgets, provenance, and human-in-the-loop are built with the *first* AI call, not after |
| Plugin API frozen wrong | P9 | Frozen only after three structurally different domains + a mandated chafe report |
| Hidden single-view assumptions | P10 | Projection extraction gated on byte-identical map goldens |
| Real-world scale collapse | P11 | Budgets become contractual CI gates, informed by dogfood data, before platform exposure |
| Multiplayer requires a rewrite | P12 | It doesn't — that's the point; the convergence fuzzer proves the P1 bet paid off |

---

*End of roadmap. First action for the implementing engineer: create the
repo, copy §5 into `CONTRIBUTING.md`, write ADR-0001, and start Phase 0.*

