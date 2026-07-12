/**
 * The `detail-resolver` capability (ARCHITECTURE.md §4.7, §14.1; ROADMAP Phase 7
 * §4–5; ADR-0027). A `DetailResolver` materializes a node's deep detail graph
 * **on demand** (drill-in), instead of at ingest — the escape valve for the
 * roadmap's headline scale risk (a 100k-LOC repo at eager AST is millions of
 * nodes, §9a). The code adapter is the first implementor (7F: a function's
 * CFG + AST); P11 persistence reuses the same cold↔hot seam.
 *
 * Everything here crosses the plugin boundary, so it is structured-clone-safe
 * (ADR-0009) and speaks the **wire IR** ({@link GraphDocument}, §6.1) — never
 * the core's branded, in-memory `SemanticNode`. A resolver's output enters the
 * store as ordinary op-based deltas through the {@link IngestSink} (ADR-0005 —
 * no second write path), exactly like an ingest.
 */
import type { GraphDocument } from '@meridian/graph-core';
import type { PluginLogger } from './context.js';
import type { IngestSink } from './parser.js';

/** The wire form of a graph node — what a resolver is handed at drill-in. A
 * store's branded `SemanticNode` widens to this structurally, so the host
 * passes a live node without a copy. Identical shape to a {@link GraphDocument}
 * node (plain-string ids, `detail.graph` a string). */
export type DetailNode = GraphDocument['graphs'][number]['nodes'][number];

/** The wire form of a detail reference (ADR-0001's recursion): a one-field
 * pointer to the graph a node is refined by. `resolve` returns the ref it set. */
export type DetailGraphRef = NonNullable<DetailNode['detail']>;

/** Injected, capability-scoped — no store reference, no ambient authority
 * (ADR-0009). `signal` lets an abandoned drill-in cancel an in-flight resolve
 * (ADR-0027: resolves run in the parse worker and honor an `AbortSignal`). */
export interface DetailContext {
  readonly apiVersion: string;
  readonly log: PluginLogger;
  readonly signal?: AbortSignal;
}

/**
 * Lazy detail materialization (ADR-0027 §DetailResolver).
 *
 * - `canResolve` is a **pure, cheap, synchronous predicate**: true iff the node
 *   is one this resolver can deepen *and* is still cold (has no `detail`). The
 *   host/UI shows a drill-in affordance from this alone, without resolving.
 * - `resolve` **materializes the detail subgraph and emits it through `sink` as
 *   op-based deltas** (a `node:detail` op flipping the node's `detail` from
 *   absent → the new graph, plus `graph:add`/`node:add`/`edge:add` for the
 *   subgraph). It is atomic, provenance-tagged, deterministic, and idempotent:
 *   resolving the same cold node twice yields byte-identical structure with
 *   identical ids (a redundant drill-in is an empty delta / cache hit). It
 *   returns the new detail {@link DetailGraphRef}.
 */
export interface DetailResolver {
  /** Matches this resolver's manifest `detail-resolver` capability `id`. */
  readonly id: string;
  canResolve(node: DetailNode): boolean;
  resolve(node: DetailNode, sink: IngestSink, ctx: DetailContext): Promise<DetailGraphRef>;
}
