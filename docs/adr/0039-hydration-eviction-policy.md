# ADR-0039 — Hydration & eviction: graph-granular shells, volatile deltas, observation-LRU with protected sets

- **Status:** Proposed
- **Date:** 2026-07-16
- **Phase:** 11 (roadmap)
- **Constitution:** ARCHITECTURE.md §4.7, §5.5, §12.2, §16.2 (memory); ADR-A1, ADR-A2
- **Roadmap:** ROADMAP.md Phase 11 §3, §7–§8 (ADR-0039); SUBPHASES.md 11C; ADR-0006, ADR-0012, ADR-0027 (the 7F pattern this reuses)

## Context

500k stored / 50k working-set nodes (§16.1) requires that opening a project
not materialize the whole space. §4.7 fixes the doctrine: per-graph hydration
states `cold | hydrating | live | evictable`, cuts never block on cold graphs,
eviction is safe by construction and writes nothing. ADR-0027 already built
the cold↔hot state machine for code bodies (drill-in triggers a resolver that
emits ordinary deltas; re-materialization is byte-identical) and explicitly
deferred eviction here. ADR-0038 supplies `StorageBackend.loadGraph` and the
`volatile` origin flag. This record fixes the in-memory representation of
coldness, who orchestrates the state machine, the eviction policy, and the
interaction with undo — under two hard constraints: one write path
(ADR-0005), and `GraphStore`'s interface unchanged (roadmap §5).

## Decision

**1. The unit of hydration is the graph** — the grain ADR-0001/0006 bought
(structural sharing, partial reads, graph-granular chunks per §16.2).

**2. Cold = shell graph.** A cold graph is *present* in the space as identity
+ metadata only: `SemanticGraph` with its real `meta` and **empty**
node/edge maps. Parent nodes keep their `detail` refs, so U1 holds, the
containment forest is intact, and drill-in affordances are visible from the
space itself. The in-memory space is always a **top slab** of the forest:

- a **live** graph has its elements present, and every child graph its nodes
  reference exists *at least* as a shell;
- a **cold** (shell) graph has no elements, and its descendants are absent
  from the space entirely (they enter as shells only when the parent
  hydrates — so a mid-forest graph never masquerades as a space root, and
  `roots` stays truthful).

Cold is distinguished from genuinely-empty by the manager (below) via the
backend manifest (`graphs.node_count/edge_count`, ADR-0038 schema), which
also supplies the summary metadata (§4.7) that sizes a closed node.

**3. `HydrationManager` orchestrates; the store stays dumb.** A new exported
class in `@meridian/graph-store` (deps unchanged: graph-core only) owning
`{ store, backend, policy }`. `GraphStore`'s interface is untouched — the
§4.7 "read API makes state visible" obligation is discharged by the manager:
`state(id): HydrationState`, `summary(id)`, `hydrate(id, {signal}):
Promise<void>`, `touch(ids)`, `pin(id)/unpin(id)`, `stats()`. It is
plain-TS, isomorphic, and I/O-free except through the injected backend.

**4. Hydration and eviction move state through the one write path as
volatile deltas** (ADR-0038 §3):

- **hydrate(G):** `cold → hydrating` (concurrent requests coalesce on one
  in-flight promise; `AbortSignal` honored) → `backend.loadGraph(G)` → one
  volatile delta: `node:add`/`edge:add` for G's elements **plus `graph:add`
  shells for every child graph G's nodes claim** → `live`. Subscriptions
  fire, caches invalidate, the next cut descends — exactly the ADR-0027
  drill-in dance, now fed from storage instead of a re-parse.
- **evict(G):** allowed only from `evictable` = live ∧ unobserved (LRU) ∧
  not protected ∧ **all of G's child graphs are cold** (deepest-first;
  eviction never strands a live descendant). One volatile delta removes G's
  edges, nodes, and its children's shells; G returns to shell; nothing is
  written (`backend.evictHint([G, ...children])` is advisory). Safe by
  construction: the durable tables/log already hold everything (§4.7), and
  IDs are content-addressed, so re-hydration is byte-identical (the ADR-0027
  invariant, now property-tested against the backend).
- Volatile deltas advance the session version and are excluded from
  durability; they are never part of undo material.

**5. Observation & budget policy.**

- **Observation** is explicit: consumers call `touch(graphIds)` — the
  navigation/session layer feeds it the cut's dependency trace (§5.5 records
  exactly which graphs a resolve read), headless callers call it directly.
  The store cannot see reads (snapshots are O(1) shared values), so
  observation is an input, not an inference.
- **Budget:** `maxResidentElements` (nodes+edges across live graphs;
  default **200k**, tunable). Crossing the high-water mark evicts
  least-recently-touched evictable graphs until ≤ 85% of budget. Hydration
  that would overshoot triggers eviction first; if nothing is evictable the
  hydration still proceeds (correctness over budget — same precedence rule
  as ADR-0014) and `stats()` reports the overshoot.
- **Protected sets, in precedence order:** pinned graphs (host API); root
  graphs; graphs touched by any non-volatile delta committed this session
  (the **undo-protection set**); graphs currently `hydrating`.

**6. Interaction with undo.** There is no store-side undo stack; undo is
`invertDelta` + `apply` (ADR-0005). The undo-protection set guarantees any
inverse of a this-session delta finds its targets live — eviction can never
make undo fail. Defense in depth: if an apply nonetheless references an
evicted element (a host bug), it fails with the ordinary located
`unknown-node`/`unknown-graph` issue — refusal, never corruption — and the
host may hydrate and retry.

**7. Cold-aware LOD (the "first interactive cut" enabler).** `LodRequest`
gains an optional `cold: ReadonlySet<GraphId>` input (pure — the resolver
stays I/O-free; the manager supplies the set). The resolver treats a node
whose `detail` graph is cold as **collapsed by necessity**: emitted as a
leaf, trace-tagged `cold` (the tag ADR-0012 reserved), and listed in the
frontier as needs-hydration. Expanding such a node is the hydration trigger
(navigation calls `hydrate` then re-resolves on the resulting ChangeSet —
the same signal path 7F specified). Cuts therefore never block on cold
graphs (§4.7).

**8. Editing discipline (v1).** Mutating elements *inside* a cold graph is
impossible by construction (they aren't in the space, so ops fail located
preconditions). Adding new elements *to* a cold shell is a host-level error
in v1: sessions hydrate before editing (drill-in already implies it). The
backend does not attempt to merge writes into unmaterialized graphs.

## Alternatives considered

- **Detail refs absent while cold (the 7F body representation).** Rejected
  for storage-backed graphs: it hides the containment forest from the space
  (spurious roots, invisible drill-in affordances) and makes hydration mutate
  *parent* graphs. Kept for never-yet-materialized adapter detail (bodies),
  which composes: a DetailResolver materializes the graph once; thereafter it
  hydrates/evicts as shells like everything else.
- **A second, non-delta mutation channel for hydration/eviction.** Rejected:
  the one-write-path law is the constitution's spine; volatile deltas get
  identical atomicity, validation, subscription, and cache-invalidation
  semantics for free.
- **Hydration state inside `GraphSpace`/`GraphMeta`.** Rejected: residency is
  session cache state, not semantic state (§12.1 strata); it would leak into
  documents, hashes, and goldens.
- **LRU by wall clock / automatic read tracking.** Rejected: the store's
  snapshots are shared immutable values — read tracking would require
  wrapping every reader; explicit `touch` from the layers that already know
  what a cut read (§5.5 traces) is exact and free.
- **Evicting subtrees bottom-up automatically (cascade eviction).** Deferred:
  v1 evicts one graph at a time deepest-first; a cascade is just repeated
  eviction and can land later without policy change.
- **Idle-priority frontier prefetch (§5.5).** Explicitly deferred to the
  incremental-pipeline work (11F at the earliest) — this record only
  guarantees prefetch would be an additive consumer of `hydrate`.

## Tradeoffs & consequences

- Eviction/hydration deltas are O(graph size) op lists flowing through
  subscriptions — honest cost, bounded by graph granularity, and exactly what
  cache invalidation needs to see; measured under the 11C soak test.
- Version stamps now advance on cache movements, so "version changed" no
  longer implies "history grew". Durable history is unambiguous (the op log);
  in-session consumers already treat ChangeSets, not counter deltas, as
  meaning.
- `touch` discipline is a new obligation on session layers; forgetting it
  degrades to over-eviction (correctness unaffected — re-hydration is cheap
  and byte-identical).
- Two coldness idioms coexist (shell graphs for persisted content; absent
  detail for never-materialized bodies) — each matched to its lifecycle, both
  driven through the same expand-triggers-materialization signal.

## Reasoning

Shells keep every invariant the rest of the system already relies on (U1
resolution, truthful roots, visible containment) while carrying zero element
weight, so laziness stays a pure *when*, never a *what* — the ADR-0027
invariant generalized from bodies to arbitrary graphs. Routing residency
changes through volatile deltas is what makes the entire downstream stack
(subscriptions, exact invalidation, LOD re-resolution) work on partially
hydrated spaces with no new machinery. The protected-set design makes the
undo question structural rather than probabilistic.

## Future implications

P11E streaming ingest applies adapter deltas against a mostly-cold space with
bounded residency; 11F's incremental pipeline and §5.5 prefetch consume
`hydrate`/`touch` unchanged. P12 sync applies remote ops to live graphs and
lets cold ones be materialized on demand from the replicated log. The
resolved-body eviction ADR-0027 deferred here is now just eviction of body
graphs.

## Open questions for review

1. **Budget default (200k resident elements, 85% low-water).** Sized against
   the 50k-node working set with headroom for shells and edges; confirm or
   tune with 11G soak numbers.
2. **Editing-discipline v1** (hydrate-before-edit as host obligation) vs
   auto-hydrate-on-write inside the manager. Recommendation: keep the
   obligation explicit in v1; auto-hydrate is additive later.
3. **Undo-protection set growth.** It only grows within a session (bounded by
   session edits). Acceptable for v1? A ring-buffer cap would trade "undo
   always works" for memory; recommend: no cap in v1.
