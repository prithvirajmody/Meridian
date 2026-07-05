/**
 * Fixtures for the LOD resolver suites (3D). The canonical override fixture is
 * a small ragged forest with named nodes at depths 0–2 so the interaction
 * matrix can assert exact cut membership and trace reasons. Plus a direct,
 * O(n) builder for the 1M-leaves-under-one-parent budget case (going through
 * `addNode` would be O(n²)).
 */
import {
  addGraph,
  addNode,
  asEdgeId,
  asGraphId,
  asNodeId,
  createGraphSpace,
  type AttrBag,
  type EdgeId,
  type GraphId,
  type GraphSpace,
  type NodeId,
  type SemanticEdge,
  type SemanticGraph,
  type SemanticNode,
  type SourceRef,
} from '@meridian/graph-core';
import { buildLevelChain, type LevelChain } from '../src/level-chain.js';
import type { ZoomPolicy } from '../src/zoom-policy.js';

const SRC: SourceRef = { origin: 'source', uri: 'test://resolver' };

const graph = (space: GraphSpace, id: string, domain = 'doc'): GraphSpace =>
  addGraph(space, { id: asGraphId(id), label: id, domain, provenance: SRC });
const leaf = (space: GraphSpace, graphId: string, id: string, attrs?: AttrBag): GraphSpace =>
  addNode(space, asGraphId(graphId), {
    id: asNodeId(id),
    kind: 'doc:leaf',
    label: id,
    ...(attrs ? { attrs } : {}),
    provenance: SRC,
  });
const group = (space: GraphSpace, graphId: string, id: string, detail: string, attrs?: AttrBag): GraphSpace =>
  addNode(space, asGraphId(graphId), {
    id: asNodeId(id),
    kind: 'doc:group',
    label: id,
    detail: { graph: asGraphId(detail) },
    ...(attrs ? { attrs } : {}),
    provenance: SRC,
  });

/**
 * The matrix fixture. Structure (depth in parens):
 *
 *   g0: A(0) → gA, B(0) → gB
 *   gA: A1(1) → gA1, A2(1) leaf
 *   gA1: A11(2) leaf, A12(2) leaf
 *   gB: B1(1) leaf, B2(1) leaf
 *
 * Leaves: A2, A11, A12, B1, B2 (5). Ragged: A2 is a leaf at depth 1.
 */
export function matrixSpace(): GraphSpace {
  let s = createGraphSpace();
  s = graph(s, 'g0');
  s = graph(s, 'gA');
  s = graph(s, 'gA1');
  s = graph(s, 'gB');
  // build bottom-up (detail graphs must exist as roots before being claimed)
  s = leaf(s, 'gA1', 'A11');
  s = leaf(s, 'gA1', 'A12');
  s = leaf(s, 'gA', 'A2');
  s = group(s, 'gA', 'A1', 'gA1');
  s = leaf(s, 'gB', 'B1');
  s = leaf(s, 'gB', 'B2');
  s = group(s, 'g0', 'A', 'gA');
  s = group(s, 'g0', 'B', 'gB');
  return s;
}

export const id = (s: string): NodeId => asNodeId(s);

/** A three-level chain (depths 0,1,2) for `matrixSpace`. */
export function matrixChain(): LevelChain {
  return buildLevelChain(matrixSpace());
}

/** A standard 3-level policy: boundaries at 1/3 and 2/3, mild hysteresis. */
export const policy3: ZoomPolicy = { thresholds: [1 / 3, 2 / 3], hysteresis: 0.1 };

/** A flat graph of `n` nodes with optional edges, all in one root graph. */
export function flatSpace(n: number, edges: readonly [string, string][] = []): GraphSpace {
  let s = createGraphSpace();
  s = graph(s, 'flat');
  for (let i = 0; i < n; i++) s = leaf(s, 'flat', `f${i}`);
  let e = 0;
  let space = s;
  for (const [a, b] of edges) {
    space = addNodeEdge(space, 'flat', `e${e++}`, a, b);
  }
  return space;
}

function addNodeEdge(space: GraphSpace, graphId: string, eid: string, src: string, dst: string): GraphSpace {
  const g = space.graphs.get(asGraphId(graphId))!;
  const edge: SemanticEdge = {
    id: asEdgeId(eid),
    src: asNodeId(src),
    dst: asNodeId(dst),
    kind: 'rel:x',
    attrs: {},
    provenance: SRC,
  };
  const edges = new Map(g.edges);
  edges.set(edge.id, edge);
  const graphs = new Map(space.graphs);
  graphs.set(g.id, { ...g, edges });
  return { graphs, roots: space.roots };
}

/**
 * One parent node `P` in a root graph whose detail graph holds `n` leaves —
 * the 1M-leaves-under-one-parent shape. Built directly (O(n)) rather than via
 * `addNode` (O(n²)). Optionally stamp each leaf with a `core:updated-at` /
 * `core:salience` value from `attrsFor(i)`.
 */
export function bigFanSpace(
  n: number,
  attrsFor?: (i: number) => AttrBag | undefined,
): GraphSpace {
  const rootId = asGraphId('root');
  const detailId = asGraphId('detail');

  const leaves = new Map<NodeId, SemanticNode>();
  for (let i = 0; i < n; i++) {
    const nid = asNodeId(`L${i}`);
    const attrs = attrsFor?.(i);
    leaves.set(nid, {
      id: nid,
      kind: 'doc:leaf',
      label: `L${i}`,
      attrs: attrs ?? {},
      provenance: SRC,
    });
  }
  const detail: SemanticGraph = {
    id: detailId,
    meta: { label: 'detail', domain: 'doc', provenance: SRC },
    nodes: leaves,
    edges: new Map<EdgeId, SemanticEdge>(),
  };

  const parent: SemanticNode = {
    id: asNodeId('P'),
    kind: 'doc:group',
    label: 'P',
    detail: { graph: detailId },
    attrs: {},
    provenance: SRC,
  };
  const root: SemanticGraph = {
    id: rootId,
    meta: { label: 'root', domain: 'doc', provenance: SRC },
    nodes: new Map<NodeId, SemanticNode>([[parent.id, parent]]),
    edges: new Map<EdgeId, SemanticEdge>(),
  };

  const graphs = new Map<GraphId, SemanticGraph>([
    [rootId, root],
    [detailId, detail],
  ]);
  return { graphs, roots: [rootId] };
}
