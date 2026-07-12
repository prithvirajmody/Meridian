# ADR-0027 — Laziness policy + thresholds: eager to function signatures, lazy bodies via DetailResolver

- **Status:** Accepted
- **Date:** 2026-07-11
- **Phase:** 7 (roadmap)
- **Constitution:** ARCHITECTURE.md §4.7 (lazy loading/streaming/memory), §5.5 (caching & progressive loading), §7.2 (parser lifecycle), §14.1 (`detail-resolver` capability), §16 (performance); ADR-0005 (one write path), ADR-0011 (capability enum), ADR-0012 (cold detail in LOD)
- **Roadmap:** ROADMAP.md Phase 7 §4, §5, §8 (ADR-0027), §9(a), §11

## Context

A 100k-LOC repo at eager AST is millions of nodes — the roadmap's headline scale
risk (§9a). The code level chain is project → package → module →
class/function(signatures) → control-flow → AST; the `DetailResolver` capability
(§4, §5) materializes deep detail on drill-in. This record fixes the eager/lazy
boundary, the size thresholds and budgets that make the roadmap's numbers
achievable (lazy resolve < 150 ms, 10 MB generated-file exclusion, ~100k-LOC
cold ingest < 30 s), the `DetailResolver` semantics, how lazily materialized
subgraphs get provenance and stable IDs, and how laziness composes with the P3
LOD machinery and with re-parse invalidation.

## Decision

**Eager levels (materialized at ingest, always in the store):** `code:project`,
`code:package`, `code:module`, and `code:class`/`code:function`/`code:method`
**signatures** — the declaration node with name, kind, signature attrs, and
provenance span, but **not** its body. Eager edges: `code:contains` (the
detail-graph structure), `code:imports`, and `code:calls` (ADR-0026).
*Amended 7C:* `code:contains` is **realized as detail-graph containment** —
a parent's `detail` ref holds the graph containing its children — not as
emitted `SemanticEdge` objects; the model forbids cross-graph edges, and
detail refs are exactly what P3 walks (the markdown adapter's precedent).
The adapter thus emits zero edge objects at 7C's eager levels; the kind name
stays reserved for any future genuine same-graph containment edge. Producing
`code:calls` requires *reading* bodies to find call-sites, but the body scan is a
transient parse-tree walk whose output is edges + counters on the function node —
**no `code:block`/`code:stmt`/`code:expr` nodes are persisted.** The < 30 s cold
ingest and byte-determinism apply to exactly this eager graph.

**Lazy levels (materialized on demand):** `code:block` (CFG basic blocks +
`code:flows-to` edges) and `code:stmt`/`code:expr` (the AST subgraph) — everything
*inside* a function body. A signature node's `detail` is **absent (cold)** at
ingest; drill-in triggers resolution.

**Why this line.** Signatures are O(declarations) (~10⁴–10⁵ for 100k LOC, fine);
bodies are O(LOC) (~10⁶–10⁷ eager, the risk). CFG/AST matter only when a human
reads one function — exactly the DetailResolver trigger. The eager frontier must
*reach* function signatures so the primary navigation surface (module cuts, the
import/call graph) is ready with zero resolves.

**Thresholds & budgets.**

| Budget | Value | Rationale |
|---|---|---|
| File-size exclusion | > **10 MB** *or* > 50,000 LOC | roadmap generated-file case; contributes a `code:module` node flagged `code:excluded: 'oversize'`, cold + non-resolvable |
| Generated-file exclusion | min.js, lockfiles, `@generated` sentinel, vendored dirs | `code:excluded: 'generated'` |
| User include/exclude globs & language allowlist (§6) | CLI `--include`/`--exclude`/`--lang` | **not walked** — filtered files never enter the graph (*amended 7H*: like the built-in skip-dirs; `code:excluded` ghost nodes are reserved for budget/size exclusions of *walked* files, so an excluded tree does not spray thousands of ghost nodes) |
| Lazy resolve latency | **< 150 ms p95** per function body | roadmap acceptance; one body parse, module tree cached |
| Cold ingest | **< 30 s** for ~100k LOC, eager levels only | the constraint that *forces* laziness |

**Resolution granularity — one body, one shot.** `resolve` materializes a
function's **CFG and AST together** (both derive from the single body parse;
splitting into two lazy tiers would double parse cost for no memory win). Drill-in
is therefore one resolve producing both `code:block` and `code:stmt`/`code:expr`
levels under the function. Resolved-body **eviction** (memory ceiling, cold↔hot)
is **deferred to P11**, which the roadmap states DetailResolver exists to serve
(§4); v1 materializes and keeps.

**`DetailResolver` semantics** (the `plugin-api` capability added in 7F as an
additive minor version, ADR-0010/0011 — this record specifies its contract; 7A
writes no code). *Amended 7F* — the shipped contract speaks the **wire IR**
(ADR-0009 clone-safety: `DetailNode` is a `GraphDocument` node, structurally
widened from the store's branded `SemanticNode`; `DetailGraphRef` structurally
equals `GraphRef`), carries a manifest-matching `id` like `AbstractionProvider`,
and takes an explicit capability-scoped context because this record *requires*
resolvers honor an `AbortSignal`:

```ts
interface DetailResolver {
  readonly id: string;                              // matches the manifest capability id
  canResolve(node: DetailNode): boolean;            // pure, cheap
  resolve(node: DetailNode, sink: IngestSink, ctx: DetailContext): Promise<DetailGraphRef>;
}
interface DetailContext { apiVersion; log; signal?: AbortSignal }
```

- `canResolve` is a **pure synchronous predicate**: true iff
  `node.kind ∈ {code:function, code:method}`, the node carries a body-span attr,
  and it has no `detail` yet (cold). The host/UI shows a drill-in affordance
  without resolving. *Amended 7F:* the marker is realized as **two eager attrs**
  on every body-carrying declaration: `code:body-span` (number-array, the body's
  byte span) and `code:scope-path` (the function's ADR-0028 qualified path) —
  the latter because a wire `DetailNode` does not carry its ADR-0028 coordinates,
  and body IDs must derive from the function's qualifiedName for the
  byte-identity invariant below.
- `resolve` emits the body subgraph **through the ordinary `IngestSink` as
  op-based deltas** (ADR-0005 — no second write path): a `node:detail` op setting
  the function's `detail` from absent → the new graph, plus `graph:add`/
  `node:add`/`edge:add` for the body. Atomic and provenance-tagged exactly like
  ingest. It returns the new detail `GraphRef`.
- `resolve` is **deterministic and idempotent**: resolving the same cold node
  twice yields byte-identical structure with identical IDs, so a redundant
  drill-in is an empty delta / cache hit.
- `resolve` runs in the parse worker (reusing 4C's infra, ADR-0017) and honors an
  `AbortSignal` (abandoned drill-in → cancel).

**Provenance & stable IDs of lazy subgraphs (the crux — the byte-identity
invariant).** Body IDs derive from the **same coordinate scheme as if eager**:
the function's `(domain='code', source=filePath, path=qualifiedName[+overloadHash])`
(ADR-0028) extended with body-local segments (`block-<cfgOrdinal>`,
`stmt-<astPath>`). Thus the detail `GraphId = deriveGraphId(functionCoords)` and
each body node `= deriveNodeId(functionCoords.path ++ [localSegment])` — **identical
whether materialized eagerly or lazily.** Laziness is purely a *when*, never a
*what*; a golden test materializes a body both ways and asserts byte-identity.
Every body node carries `origin: 'source'` with the file URI + span — deterministic
parse output, **not** an AI proposal, so it enters as a plain source-tagged delta.

**CFG edge semantics** (*added 7F* — this record names `code:block` +
`code:flows-to` but originally left the flow model unfixed; the builder's model
is pinned by hand-drawn truth tests in both languages and is now normative):

- Two **sentinel blocks** bracket every body: `entry` and `exit`, exactly one
  of each per function.
- A basic block is a maximal straight-line run; control-flow constructs end the
  current block and open successors.
- Flows are **labelled** (`code:flow` attr):
  `seq | true | false | loop | break | continue | return | exception | fallthrough | finally`.
  `if` arms rejoin at a fresh block; loops have a head block with `true` → body,
  `false` → after, and a `loop` back-edge from the body's normal end;
  `do…while` tests at the tail. TS `switch` cases fall through (`fallthrough`)
  until a `break`; Python `match` arms each rejoin (no fallthrough).
- Abrupt exits (`return`, `break`, `continue`, `throw`/`raise`) route **through
  any enclosing `finally`** before reaching their target.
- Exception edges go to the innermost enclosing handler, else finalizer, else
  `exit`. **Implicit**-exception edges are modelled once, from the protected
  region's entry block — a bounded, documented over-approximation (a real
  analysis would edge every statement).
- A `finally` region is a single block region; its out-edges are the **union of
  the continuations it intercepts** (normal successor plus each abrupt target).
  Precise for one finalizer; a documented over-approximation for nested
  finalizers.

**Composition with P3 LOD (ADR-0012/0013/0014) — no change to those ADRs.** A cold
body is exactly ADR-0012's "cold (unhydrated) detail graph": the resolver emits
the node with trace tag `cold`, and it appears in `frontier.expandable` flagged
needs-hydration. An **`expand` override on a cold node is the drill-in trigger**:
the LOD resolver cannot descend (detail absent) so it emits the node `cold` and
signals the navigation layer to call `DetailResolver.resolve`; the resulting store
delta re-fires the subscription and the next resolve descends normally. Under
budget (ADR-0014) a cold body counts as a collapsed leaf (zero materialized
descendants), so it is naturally cheap to keep collapsed — ADR-0014 already
anticipates this ("cold detail counts as a collapsed leaf").

**Composition with re-parse invalidation (7G / ADR-0028).** On a file change, only
**materialized (hot)** bodies are re-materialized; cold bodies stay cold (nothing
in the store to invalidate). A hot body whose function is unchanged
(whitespace-only, ADR-0028) yields an **empty delta**; a hot body whose function
changed is re-resolved and diffed to a minimal delta. Laziness therefore *reduces*
incremental work: an edit touches the eager graph plus only the currently-hot
bodies.

## Alternatives considered

- **Eager everything.** Rejected: millions of nodes, blows the 30 s + memory
  budgets — the named risk.
- **Lazy from the module level down.** Rejected: module signatures are cheap and
  are the always-visible import/call surface; making them lazy would make the
  *default* view require a resolve.
- **Separately-lazy CFG and AST (two tiers).** Rejected: both come from one body
  parse; splitting doubles parse cost with no memory win.
- **Resolver mutates the store directly / returns a detached subgraph the host
  stitches.** Rejected: the first violates the one-write-path law; the second
  loses atomicity and provenance. `resolve` emits deltas through the sink.

## Tradeoffs & consequences

Buys the scale budget and a small always-ready navigation graph; costs a resolve
latency on first drill-in (< 150 ms, gated) and a "drill-in triggers resolve"
dance that reuses the existing `cold` machinery. The byte-identical eager/lazy
invariant costs discipline in ID derivation but buys testability — goldens are
laziness-agnostic.

## Reasoning

Laziness is sound only if lazy == eager in every observable (IDs, structure,
provenance); deriving body IDs from the function's coordinates guarantees that, so
laziness is a pure performance transform over a deterministic mapping. The line
sits at the function boundary because that is where node count goes from
O(declarations) to O(LOC) and where human attention goes from browsing to reading.

## Future implications

P11 hydration/eviction reuses the DetailResolver cold↔hot state machine and adds
the memory ceiling. P8 AI can summarize a cold body from its signature without
resolving, or trigger a resolve for deep analysis. More languages add resolvers
under the same contract. `detail-resolver` joins the capability enum (ADR-0011
reserves the name in §14.1) as the **first post-P2 contract change** — additive
minor version (ADR-0010), noted for the P9 chafe report.

## Open questions for review

1. **The numbers.** ~~150 ms / 10 MB / 50k LOC / 30 s — confirm as v1 gates
   pending 7H's real reference-hardware measurements.~~ *Resolved 7H —
   confirmed as v1 gates.* Measured on gate hardware: lazy resolve p95
   **4.78 ms** (budget 150 ms), cold ingest of ~153k-LOC vue-core **2.79 s**
   (budget 30 s; 7.44 s under parallel suite load — still 4× headroom), the
   >10 MB exclusion fires as specified. Budgets kept as written: the headroom
   absorbs slower hardware and larger bodies.
2. **`code:calls` body-scan cap.** Should the eager call-site scan be
   budget-capped for a pathological huge function (e.g. a 5,000-line switch)?
   Proposed: no separate cap in v1 (bounded by the 10 MB file limit); flag.
3. **Eviction hook.** Fully defer resolved-body eviction to P11 (recommended) vs
   stub a count ceiling in v1. Confirm.
