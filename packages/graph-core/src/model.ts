/**
 * The USG object model, Phase 0 slice (ARCHITECTURE.md §3.1; ROADMAP.md
 * Phase 0 §7). Meaning only — no geometry ever enters these types (§3.3).
 */
import type { AttrBag } from './attrs.js';
import type { EdgeId, GraphId, NodeId } from './ids.js';

/**
 * Where an element came from. "Unknown" is not a valid origin (U7). The AI
 * provenance quartet (`providerId`, `model`, `promptVersion`, `inputHash`) is
 * the ADR-0030 replay key: for `origin:'ai'` elements it names the exact,
 * reproducible call that produced them (ADR-0031). All four are optional and
 * additive — pre-P8 records without them stay valid, and provenance never
 * participates in node identity (ADR-0002).
 */
export interface SourceRef {
  readonly origin: 'source' | 'derived' | 'ai';
  readonly uri?: string;
  readonly span?: readonly [number, number];
  /** The routed AI provider adapter id (ADR-0029/0030). */
  readonly providerId?: string;
  readonly model?: string;
  /** The `PromptSpec` version this output was generated under (ADR-0030). */
  readonly promptVersion?: string;
  /** Canonical hash of the rendered request payload (ADR-0030 replay key). */
  readonly inputHash?: string;
  readonly confidence?: number;
}

/**
 * The recursion (ADR-0001): a reference to another graph in the same space.
 * A one-field object so lazy-hydration hints (§4.7) can be added additively.
 */
export interface GraphRef {
  readonly graph: GraphId;
}

export interface GraphMeta {
  readonly label: string;
  readonly domain: string;
  readonly provenance: SourceRef;
}

export interface SemanticNode {
  readonly id: NodeId;
  /** Namespaced: 'code:function', 'core:cluster'. */
  readonly kind: string;
  readonly label: string;
  /** The recursion: this node contains (is refined by) a graph. */
  readonly detail?: GraphRef;
  readonly attrs: AttrBag;
  readonly provenance: SourceRef;
}

/** Directed, typed connection between two nodes of the SAME graph (U1). */
export interface SemanticEdge {
  readonly id: EdgeId;
  readonly src: NodeId;
  readonly dst: NodeId;
  readonly kind: string;
  readonly weight?: number;
  readonly attrs: AttrBag;
  readonly provenance: SourceRef;
}

export interface SemanticGraph {
  readonly id: GraphId;
  readonly meta: GraphMeta;
  readonly nodes: ReadonlyMap<NodeId, SemanticNode>;
  readonly edges: ReadonlyMap<EdgeId, SemanticEdge>;
}

/**
 * The universe of one project (ADR-0001): a FLAT collection of graphs,
 * related only by detail references. `roots` are the graphs contained by no
 * node; the array is redundant with the derived relation and is validated,
 * never trusted.
 */
export interface GraphSpace {
  readonly graphs: ReadonlyMap<GraphId, SemanticGraph>;
  readonly roots: readonly GraphId[];
}
