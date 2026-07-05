# ADR-0001 — Recursion representation: flat GraphSpace with reference-based recursion

- **Status:** Proposed
- **Date:** 2026-07-05
- **Phase:** 0 (roadmap)
- **Constitution:** ARCHITECTURE.md §4 (recursive graph model), §3.1–3.3, ADR-A1, ADR-A6
- **Roadmap:** ROADMAP.md Phase 0 §8 (ADR-0001)

## Context

The USG must represent recursion — every node may contain a graph, to arbitrary
depth — and it must do so in a way that survives lazy loading, structural
sharing, local deltas, and (eventually) collaboration. This is the single most
consequential and least-reversible modeling decision in the platform, so it is
made first, in isolation, before pixels, plugins, or AI can pressure it into a
shortcut. The constitution already fixes the answer in principle (§4, ADR-A1);
this record makes it implementation-grade and names the Phase 0 shapes.

## Decision

Recursion is represented by a **flat `GraphSpace`** in which a node optionally
carries a **detail reference** to another graph in the same space. Nothing is
ever physically nested inside a node payload.

- `GraphSpace = { graphs: ReadonlyMap<GraphId, SemanticGraph>; roots: GraphId[] }`.
  The space is the unit of identity, versioning, and persistence. It is *flat*:
  graphs sit side by side in one map, related only by reference.
- A `SemanticNode` may carry `detail?: GraphRef`, where `GraphRef = { graph: GraphId }`
  points at another graph in the same space. That pointer — and only that
  pointer — is "node N contains graph G." `GraphRef` is a one-field object
  (not a bare `GraphId`) so lazy-hydration hints (§4.7) can be added additively
  later without a shape change.
- The **containment relation** is derived from detail references and owned by the
  space in one canonical direction (node → detail graph). Node → parent and
  graph → containing-node are *derived accessors*, never stored, so there is no
  bidirectional state to desynchronize (§4.2). Containment forms a **forest**
  (invariant U2); `roots` are the graphs contained by no node.
- **Edges connect two nodes of the same graph only.** Raw cross-graph edges are
  forbidden (§3.3). A conceptual link across a containment boundary is recorded
  as an ordinary edge at the **lowest common containing graph** of the two
  endpoints, between the two ancestors that are siblings there, with the precise
  deep endpoints carried as element metadata (the *portal rule*, §4.3). The
  aggregation/induction and portal *rendering* of such links is Phase 3+; Phase 0
  fixes only (a) that the model forbids cross-graph edges, (b) that every edge
  endpoint resolves within the edge's own graph, and (c) that cross-boundary
  links have a legal recorded form so the fixture corpus can express them.
- No geometry ever enters the model (§3.3); positions/sizes/colors are view state.

Phase 0 invariants this locks in: **U1** referential integrity (every endpoint
and every `detail` ref resolves), **U2** acyclic containment (forest), **U3**
single ownership (each node/edge in exactly one graph; each graph the detail of
at most one node).

## Alternatives considered

- **Physically nested documents** (a graph embedded in its node's payload).
  Rejected: a nested subtree must be parsed to be skipped (lazy loading becomes
  impossible); structural sharing forces deep copies along the entire ancestor
  path on every change; a delta to a deep node must address a path through every
  ancestor document instead of `(graphId, nodeId)`; traversal cost is hidden in
  object shape.
- **One flat graph with a `parent` attribute, no graph boundaries.** Rejected:
  loses the unit of lazy loading, hydration, and eviction; loses the namespace
  within which edges are meaningful; every query must filter the whole node set
  by parent.
- **Multi-parent containment (a DAG, a node shared by several parents).**
  Rejected here and documented as an escape hatch (§4.5, ADR-A6): it makes cut
  semantics ambiguous (which containment path wins in a slice?) and lifecycle
  ambiguous (who may delete a shared node?). Apparent sharing is modeled instead
  as single ownership + `references` edges. Reopening this is a major, planned
  amendment, never a quiet exception.

## Tradeoffs & consequences

- **Cost:** referential integrity (U1) must be *actively maintained* by the store
  and checked at the gate, rather than being structurally impossible to violate;
  serialization must order graphs for streaming (ADR-0004). Both costs are paid
  once, in the store and codec.
- **Benefit:** lazy loading is a pointer discipline; immutable snapshots share
  unchanged graphs by reference; deltas stay local; each graph is independently
  loadable, verifiable, and evictable; "zoom in" is a dereference, not a tree
  walk.

## Reasoning

Every scale, incrementality, and collaboration requirement gets *easier* under
flatness; only serializer convenience gets harder — and that cost is bounded and
central. The nesting alternative pays its costs everywhere, forever.

## Future implications

Enables cold-graph persistence (§15), the portal rule (§4.3), and graph-granular
sync (§21). Commits the platform to maintaining U1 forever and to the
graph-ordering discipline in serialization (ADR-0004). If a domain ever proves it
needs true multi-parent containment, that is a constitution-level amendment with
a redesign of cut semantics (ADR-A6), not a local change.
