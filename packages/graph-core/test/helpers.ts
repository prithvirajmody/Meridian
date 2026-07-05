import {
  addEdge,
  addGraph,
  addNode,
  asEdgeId,
  asGraphId,
  asNodeId,
  createGraphSpace,
  type GraphSpace,
  type SourceRef,
} from '../src/index.js';

export const SRC: SourceRef = { origin: 'source', uri: 'test://helpers' };

/**
 * A small hand-built valid space, 3 containment levels:
 * g-root (n-a [detail g-mid], n-b, e-ab) → g-mid (n-c [detail g-leaf]) → g-leaf (n-d).
 */
export function demoSpace(): GraphSpace {
  let s = createGraphSpace();
  s = addGraph(s, { id: asGraphId('g-root'), label: 'Root', domain: 'demo', provenance: SRC });
  s = addGraph(s, { id: asGraphId('g-mid'), label: 'Mid', domain: 'demo', provenance: SRC });
  s = addGraph(s, { id: asGraphId('g-leaf'), label: 'Leaf', domain: 'demo', provenance: SRC });
  s = addNode(s, asGraphId('g-leaf'), {
    id: asNodeId('n-d'),
    kind: 'demo:step',
    label: 'd',
    provenance: SRC,
  });
  s = addNode(s, asGraphId('g-mid'), {
    id: asNodeId('n-c'),
    kind: 'demo:step',
    label: 'c',
    detail: { graph: asGraphId('g-leaf') },
    provenance: SRC,
  });
  s = addNode(s, asGraphId('g-root'), {
    id: asNodeId('n-a'),
    kind: 'demo:module',
    label: 'a',
    detail: { graph: asGraphId('g-mid') },
    provenance: SRC,
  });
  s = addNode(s, asGraphId('g-root'), {
    id: asNodeId('n-b'),
    kind: 'demo:module',
    label: 'b',
    provenance: SRC,
  });
  s = addEdge(s, asGraphId('g-root'), {
    id: asEdgeId('e-ab'),
    src: asNodeId('n-a'),
    dst: asNodeId('n-b'),
    kind: 'core:references',
    weight: 0.5,
    provenance: SRC,
  });
  return s;
}
