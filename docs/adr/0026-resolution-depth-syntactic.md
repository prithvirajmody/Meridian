# ADR-0026 — Resolution depth: syntactic + import-graph only, no type checker

- **Status:** Accepted
- **Date:** 2026-07-11
- **Phase:** 7 (roadmap)
- **Constitution:** ARCHITECTURE.md §7.1–7.3 (parsers; code domain notes; precision honesty), §3.1 (Relationship taxonomy, Provenance), §8.1 (advisory/honest stance); ADR-A1
- **Roadmap:** ROADMAP.md Phase 7 §3, §8 (ADR-0026), §9(c), §10

## Context

`adapters/code` must produce `code:imports` (module→module) and `code:calls`
(function→function) edges so P3 module cuts carry cross-links. A *precise* call
graph needs type resolution — which declaration does `x.foo()` bind to? A type
checker (tsc, pyright, jedi) is a heavy dependency, slow enough to threaten the
< 30 s cold-ingest budget, non-deterministic across tool versions, and
language-specific (defeating the "each language is a plugin" thesis, §7.3). The
roadmap fixes the boundary — *syntactic + import-graph only; no type checker;
edges carry `confidence: 'syntactic'`; type-aware resolution deferred* (§8, §10)
— and demands written, measurable revisit criteria. This record commits the
resolution algorithm, the honest treatment of what does not resolve, and that
criterion.

## Decision

**Two edge families, resolved purely from parse trees + a lexical import table,
with no type inference.**

**`code:imports` (module→module).** Resolved *lexically* from import/require/
`from` statements: a relative specifier is resolved against the ingested file
tree (extension + index/package-root rules per language); a bare specifier that
resolves to no ingested file is **external** (a library, or an excluded path).
This is path resolution, not type resolution.

**`code:calls` (enclosing function → callee declaration).** Resolved only by
these tiers, in order:

1. **Same-module lexical scope.** The callee identifier binds to a
   function/method/class declared in the same file, by ordinary scoping (local
   function, module-level function, a method called on `this`/`self` inside its
   own class). → edge, `code:confidence: 'syntactic'`.
2. **Import-bound cross-module.** The callee identifier is an imported name whose
   import resolves (via `code:imports`) to an ingested module exporting a
   matching top-level declaration. → edge to that declaration,
   `code:confidence: 'syntactic'`.
3. **Unresolved.** Everything else: method calls on values of unknown type
   (`x.foo()`), higher-order/dynamic dispatch, calls into external/uningested
   modules, and calls to a name with **more than one** syntactic binding
   candidate (overloads, duplicates) that syntax cannot disambiguate.

**Unresolved calls: omission with counters, never a synthetic node/edge.** Tier-3
call-sites produce **no** edge and **no** placeholder callee node. Instead every
`code:function`/`code:method` node carries honest, aggregatable counters:

| Attr | Meaning |
|---|---|
| `code:calls-resolved` | outbound call-sites that produced a `code:calls` edge |
| `code:calls-unresolved` | outbound in-repo call-sites that did not resolve |
| `code:calls-external` | subset whose callee is import-bound to a module *outside* the ingested set |

A **repeated (caller→callee) pair** collapses to **one** `code:calls` edge with
`weight = callSiteCount` (matching ADR-0013's weight/multiplicity model and
keeping the base graph small) plus up to 3 sampled call-site spans in an attr —
rather than N parallel edges; ADR-0002's edge `occurrence` key stays reserved for
a genuinely-needed future case.

**Confidence enum.** `code:confidence ∈ {'syntactic', 'typed'}`; v1 emits only
`'syntactic'` (declared in the adapter manifest `attrSchemas`). `'typed'` is
reserved for a future type-aware pass.

**Determinism.** Resolution is a pure function of (parse trees, ingested file
set, import table): no network, no `tsconfig` type magic. A name with > 1
candidate binding is **unresolved** (counted), never arbitrarily picked —
arbitrary choice would be a confident wrong edge.

**Revisit criterion (measurable).** The counters *are* the instrument. Define,
per language over the Phase 7H dogfood corpora,
`resolutionRate = Σ code:calls-resolved / Σ (code:calls-resolved + code:calls-unresolved)`
— external calls excluded from the denominator (they are honestly out of scope,
not failures). 7H emits `resolutionRate` as a gate metric. **If `resolutionRate`
< 0.60 for either language on the dogfood corpus** *and* a reviewer judges the
resulting module-level `code:calls` induced graph unusable, the type-aware
resolution ADR is opened. The floor is a recorded number, not a vibe; its exact
value is provisional until 7H produces real measurements (see Open questions).

## Alternatives considered

- **Full type checker (tsc/pyright/jedi API).** Rejected: heavy dep, threatens
  the 30 s budget, version-nondeterministic, language-bound, and far more than
  P3 induced edges require.
- **Synthetic `unresolved` callee nodes/edges.** Rejected: one sink node becomes
  a mega-hub that wrecks induced-edge aggregation and layout; one-per-call-site
  explodes the node count (the very thing ADR-0027 fights); and an edge to a node
  we cannot name is not a fact — a counter is the honest record (§8.1).
- **Whole-repo name matching** (resolve `foo()` to any `foo` anywhere). Rejected:
  high false-positive rate, non-local, produces confident wrong edges — worse
  than honest omission.
- **Lightweight local type inference.** Rejected for v1: scope-creep toward a
  type checker with none of its guarantees; the revisit criterion is the escape
  hatch.

## Tradeoffs & consequences

Buys determinism, speed, language symmetry, and honesty (confidence attr +
counters). Costs: most *method*-call edges are absent in v1 — documented, and the
counters make the gap visible and measurable. The module induced graph is
import-dominated with a partial call overlay, which is enough to make module cuts
readable (§5.3).

## Reasoning

P3 module cuts need *some* honest cross-module signal; imports alone already give
it, calls are the bonus. Precision honesty (confidence + counters) is the
constitution's provenance discipline (§8.1) applied to edges: never assert a
relationship we cannot verify syntactically. A type checker is the wrong
cost/determinism trade for that payoff.

## Future implications

A `'typed'` confidence tier and a type-aware resolver are additive — a new attr
value and a richer resolver behind the *same* edge kinds, no schema break. The
counters become the eval metric that justifies (or not) building it. Cross-repo
and library-internal resolution stay deferred (roadmap §10).

## Open questions for review

1. **Resolution-rate floor.** 0.60 is a placeholder with no measurement yet;
   confirm the value or defer setting it until 7H produces real numbers.
2. **Import resolution scope.** v1 honors relative specifiers and package-root
   resolution; `tsconfig` `paths` aliases and Python namespace packages are
   proposed *deferred* (aliased imports → external). Confirm, or require alias
   resolution in v1.
3. **Repeated call-site representation.** One weighted edge + sampled spans
   (recommended) vs N parallel edges with ADR-0002 `occurrence` keys. Confirm.
