/**
 * Pure constructors (ROADMAP Phase 0 §6): append-only, returning new spaces
 * with structural sharing (untouched graphs are shared by reference —
 * ADR-0001). Mutation machinery (deltas, transactions) is Phase 1; there is
 * deliberately no update or remove here.
 *
 * Builders enforce cheap local invariants and throw `MeridianError` on
 * immediate misuse. Space-global checks (cross-graph duplicate IDs, root
 * consistency, NFC discipline over hand-built objects) are `validate`'s job.
 */
import { isValidAttrValue, KIND_PATTERN, type AttrBag } from './attrs.js';
import { MeridianError } from './errors.js';
import { COORD_SEPARATOR, type EdgeId, type GraphId, type NodeId } from './ids.js';
import type {
  GraphRef,
  GraphSpace,
  SemanticEdge,
  SemanticGraph,
  SemanticNode,
  SourceRef,
} from './model.js';
import { canonAttrs, canonNumber, canonProvenance, nfc } from './normalize.js';
import { buildContainmentIndex } from './traverse.js';

const ORIGINS = new Set(['source', 'derived', 'ai']);

function checkProvenance(p: SourceRef, what: string): void {
  if (!ORIGINS.has(p.origin)) {
    throw new MeridianError(
      'invalid-provenance',
      `${what}: origin must be 'source' | 'derived' | 'ai' (U7 — "unknown" is not a valid origin)`,
    );
  }
  if (p.confidence !== undefined && !(p.confidence >= 0 && p.confidence <= 1)) {
    throw new MeridianError('invalid-provenance', `${what}: confidence must be in [0, 1]`);
  }
  if (p.span !== undefined) {
    const [start, end] = p.span;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
      throw new MeridianError(
        'invalid-provenance',
        `${what}: span must be [start, end] with 0 <= start <= end, integers`,
      );
    }
  }
}

function checkKind(kind: string, what: string): string {
  const k = nfc(kind);
  if (!KIND_PATTERN.test(k)) {
    throw new MeridianError(
      'invalid-kind',
      `${what}: kind "${kind}" must match ns:name with [a-z][a-z0-9-]* parts (ADR-0003)`,
    );
  }
  return k;
}

function checkId(id: string, what: string): void {
  if (id.length === 0 || id.includes(COORD_SEPARATOR)) {
    throw new MeridianError('invalid-id', `${what}: IDs must be non-empty and free of U+001F`);
  }
}

function checkAttrs(attrs: AttrBag, what: string): AttrBag {
  for (const [key, value] of Object.entries(attrs)) {
    if (!isValidAttrValue(value)) {
      throw new MeridianError(
        'invalid-attr-value',
        `${what}: attr "${key}" must be a scalar or homogeneous scalar array (ADR-0003)`,
      );
    }
  }
  return canonAttrs(attrs);
}

export function createGraphSpace(): GraphSpace {
  return { graphs: new Map(), roots: [] };
}

export interface GraphInit {
  readonly id: GraphId;
  readonly label: string;
  readonly domain: string;
  readonly provenance: SourceRef;
}

/** Adds an empty graph. Until a node claims it as detail, it is a root. */
export function addGraph(space: GraphSpace, init: GraphInit): GraphSpace {
  checkId(init.id, 'addGraph');
  const id = nfc(init.id) as GraphId;
  if (space.graphs.has(id)) {
    throw new MeridianError('duplicate-id', `addGraph: graph "${id}" already exists`);
  }
  const domain = nfc(init.domain);
  if (domain.length === 0) {
    throw new MeridianError('invalid-domain', 'addGraph: domain must be non-empty');
  }
  checkProvenance(init.provenance, `addGraph "${id}"`);
  const graph: SemanticGraph = {
    id,
    meta: {
      label: nfc(init.label),
      domain,
      provenance: canonProvenance(init.provenance),
    },
    nodes: new Map(),
    edges: new Map(),
  };
  const graphs = new Map(space.graphs);
  graphs.set(id, graph);
  return { graphs, roots: [...space.roots, id] };
}

export interface NodeInit {
  readonly id: NodeId;
  readonly kind: string;
  readonly label: string;
  readonly attrs?: AttrBag;
  readonly provenance: SourceRef;
  readonly detail?: GraphRef;
}

/**
 * Adds a node to `graphId`. If `detail` is given, the referenced graph must
 * already exist, must currently be a root (U3 — a graph is the detail of at
 * most one node), and must not be an ancestor of `graphId` (U2 — containment
 * stays a forest). The target graph stops being a root.
 */
export function addNode(space: GraphSpace, graphId: GraphId, init: NodeInit): GraphSpace {
  const graph = space.graphs.get(graphId);
  if (!graph) {
    throw new MeridianError('unknown-graph', `addNode: graph "${graphId}" does not exist`);
  }
  checkId(init.id, 'addNode');
  const id = nfc(init.id) as NodeId;
  if (graph.nodes.has(id)) {
    throw new MeridianError(
      'duplicate-id',
      `addNode: node "${id}" already exists in graph "${graphId}"`,
    );
  }
  const kind = checkKind(init.kind, `addNode "${id}"`);
  checkProvenance(init.provenance, `addNode "${id}"`);
  const attrs = checkAttrs(init.attrs ?? {}, `addNode "${id}"`);

  let roots = space.roots;
  let detail: GraphRef | undefined;
  if (init.detail) {
    const target = nfc(init.detail.graph) as GraphId;
    if (!space.graphs.has(target)) {
      throw new MeridianError(
        'unknown-detail-graph',
        `addNode "${id}": detail graph "${target}" does not exist`,
      );
    }
    if (!space.roots.includes(target)) {
      throw new MeridianError(
        'detail-not-root',
        `addNode "${id}": graph "${target}" is already contained by another node (U3)`,
      );
    }
    // U2: target must not be an ancestor of (or equal to) the host graph.
    const index = buildContainmentIndex(space);
    for (
      let ancestor: GraphId | undefined = graphId;
      ancestor !== undefined;
      ancestor = index.get(ancestor)?.parentGraph
    ) {
      if (ancestor === target) {
        throw new MeridianError(
          'containment-cycle',
          `addNode "${id}": making "${target}" the detail of a node in "${graphId}" would create a containment cycle (U2)`,
        );
      }
    }
    detail = { graph: target };
    roots = space.roots.filter((r) => r !== target);
  }

  const node: SemanticNode = {
    id,
    kind,
    label: nfc(init.label),
    ...(detail ? { detail } : {}),
    attrs,
    provenance: canonProvenance(init.provenance),
  };
  const nodes = new Map(graph.nodes);
  nodes.set(id, node);
  const graphs = new Map(space.graphs);
  graphs.set(graphId, { ...graph, nodes });
  return { graphs, roots };
}

export interface EdgeInit {
  readonly id: EdgeId;
  readonly src: NodeId;
  readonly dst: NodeId;
  readonly kind: string;
  readonly weight?: number;
  readonly attrs?: AttrBag;
  readonly provenance: SourceRef;
}

/** Adds an edge between two existing nodes of `graphId` (U1: same graph). */
export function addEdge(space: GraphSpace, graphId: GraphId, init: EdgeInit): GraphSpace {
  const graph = space.graphs.get(graphId);
  if (!graph) {
    throw new MeridianError('unknown-graph', `addEdge: graph "${graphId}" does not exist`);
  }
  checkId(init.id, 'addEdge');
  const id = nfc(init.id) as EdgeId;
  if (graph.edges.has(id)) {
    throw new MeridianError(
      'duplicate-id',
      `addEdge: edge "${id}" already exists in graph "${graphId}"`,
    );
  }
  const src = nfc(init.src) as NodeId;
  const dst = nfc(init.dst) as NodeId;
  for (const [endpoint, name] of [
    [src, 'src'],
    [dst, 'dst'],
  ] as const) {
    if (!graph.nodes.has(endpoint)) {
      throw new MeridianError(
        'unknown-node',
        `addEdge "${id}": ${name} "${endpoint}" is not a node of graph "${graphId}" (cross-graph edges are forbidden — record links at the lowest common graph, ADR-0001)`,
      );
    }
  }
  const kind = checkKind(init.kind, `addEdge "${id}"`);
  checkProvenance(init.provenance, `addEdge "${id}"`);
  if (init.weight !== undefined && !Number.isFinite(init.weight)) {
    throw new MeridianError('invalid-weight', `addEdge "${id}": weight must be finite`);
  }
  const attrs = checkAttrs(init.attrs ?? {}, `addEdge "${id}"`);

  const edge: SemanticEdge = {
    id,
    src,
    dst,
    kind,
    ...(init.weight !== undefined ? { weight: canonNumber(init.weight) } : {}),
    attrs,
    provenance: canonProvenance(init.provenance),
  };
  const edges = new Map(graph.edges);
  edges.set(id, edge);
  const graphs = new Map(space.graphs);
  graphs.set(graphId, { ...graph, edges });
  return { graphs, roots: space.roots };
}
