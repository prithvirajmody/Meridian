/**
 * Hand-built spaces for the failure/edge fixtures the phase names: empty and
 * single-node graphs, ragged hierarchies (mixed depths), orphans (a second,
 * disconnected root), and a node whose detail graph is empty (a leaf, the
 * shape Phase 11's cold state will also present as). Built bottom-up because
 * `addNode`'s detail must reference an existing root graph (U3/U2).
 */
import {
  addGraph,
  addNode,
  asGraphId,
  asNodeId,
  createGraphSpace,
  type GraphSpace,
  type SourceRef,
} from '@meridian/graph-core';

const SRC: SourceRef = { origin: 'source', uri: 'test://fixtures' };
const graph = (space: GraphSpace, id: string, domain = 'doc'): GraphSpace =>
  addGraph(space, { id: asGraphId(id), label: id, domain, provenance: SRC });
const leaf = (space: GraphSpace, graphId: string, id: string): GraphSpace =>
  addNode(space, asGraphId(graphId), {
    id: asNodeId(id),
    kind: 'doc:leaf',
    label: id,
    provenance: SRC,
  });
const group = (space: GraphSpace, graphId: string, id: string, detail: string): GraphSpace =>
  addNode(space, asGraphId(graphId), {
    id: asNodeId(id),
    kind: 'doc:group',
    label: id,
    detail: { graph: asGraphId(detail) },
    provenance: SRC,
  });

/** No graphs at all — zero leaves, zero levels, fallback domain. */
export function emptySpace(): GraphSpace {
  return createGraphSpace();
}

/** One root graph, one leaf node (depth 0). */
export function singleNodeSpace(): GraphSpace {
  return leaf(graph(createGraphSpace(), 'g'), 'g', 'n');
}

/** A straight ladder n0 → n1 → n2(leaf): depths 0,1,2 ⇒ 3 levels. */
export function laddderSpace(): GraphSpace {
  let s = createGraphSpace();
  s = graph(s, 'g');
  s = graph(s, 'g1');
  s = graph(s, 'g2');
  s = leaf(s, 'g2', 'n2');
  s = group(s, 'g1', 'n1', 'g2');
  s = group(s, 'g', 'n0', 'g1');
  return s;
}

/** Mixed depths under one root: A(0), B→B1(1), C→C1→C11(2). */
export function raggedSpace(): GraphSpace {
  let s = createGraphSpace();
  s = graph(s, 'g');
  s = graph(s, 'gB');
  s = graph(s, 'gC');
  s = graph(s, 'gC1');
  s = leaf(s, 'g', 'A');
  s = leaf(s, 'gB', 'B1');
  s = leaf(s, 'gC1', 'C11');
  s = group(s, 'gC', 'C1', 'gC1');
  s = group(s, 'g', 'B', 'gB');
  s = group(s, 'g', 'C', 'gC');
  return s;
}

/** Two disconnected root graphs: a small tree plus a lone orphan node. */
export function orphanSpace(): GraphSpace {
  let s = createGraphSpace();
  s = graph(s, 'g-main');
  s = graph(s, 'g-sub');
  s = graph(s, 'g-orphan');
  s = leaf(s, 'g-sub', 'm1');
  s = group(s, 'g-main', 'm', 'g-sub');
  s = leaf(s, 'g-orphan', 'orphan');
  return s;
}

/** A node whose detail graph is empty ⇒ it is a leaf, alongside a plain leaf. */
export function emptyDetailSpace(): GraphSpace {
  let s = createGraphSpace();
  s = graph(s, 'g');
  s = graph(s, 'g-empty');
  s = group(s, 'g', 'e', 'g-empty'); // detail is empty ⇒ e is a leaf
  s = leaf(s, 'g', 'n');
  return s;
}
