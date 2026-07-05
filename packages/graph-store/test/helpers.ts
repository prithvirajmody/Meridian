import {
  addEdge,
  addGraph,
  addNode,
  asEdgeId,
  asGraphId,
  asNodeId,
  encodeCanonical,
  type GraphSpace,
  type SourceRef,
} from '@meridian/graph-core';
import type { OpOrigin } from '../src/index.js';

export const SRC: SourceRef = { origin: 'source', uri: 'test://helpers' };
export const ORIGIN: OpOrigin = { actor: 'test' };

export const gRoot = asGraphId('g-root');
export const gMid = asGraphId('g-mid');
export const gLeaf = asGraphId('g-leaf');
export const nA = asNodeId('n-a');
export const nB = asNodeId('n-b');
export const nC = asNodeId('n-c');
export const nD = asNodeId('n-d');
export const eAB = asEdgeId('e-ab');

/**
 * Same shape as graph-core's test space, 3 containment levels:
 * g-root (n-a [detail g-mid], n-b, e-ab) → g-mid (n-c [detail g-leaf]) → g-leaf (n-d).
 */
export function demoSpace(): GraphSpace {
  let s = addGraph(addGraph(addGraph({ graphs: new Map(), roots: [] }, {
    id: gRoot, label: 'Root', domain: 'demo', provenance: SRC,
  }), { id: gMid, label: 'Mid', domain: 'demo', provenance: SRC }), {
    id: gLeaf, label: 'Leaf', domain: 'demo', provenance: SRC,
  });
  s = addNode(s, gLeaf, { id: nD, kind: 'demo:step', label: 'd', provenance: SRC });
  s = addNode(s, gMid, {
    id: nC, kind: 'demo:step', label: 'c', detail: { graph: gLeaf }, provenance: SRC,
  });
  s = addNode(s, gRoot, {
    id: nA, kind: 'demo:module', label: 'a', detail: { graph: gMid }, provenance: SRC,
  });
  s = addNode(s, gRoot, { id: nB, kind: 'demo:module', label: 'b', provenance: SRC });
  s = addEdge(s, gRoot, {
    id: eAB, src: nA, dst: nB, kind: 'core:references', weight: 0.5, provenance: SRC,
  });
  return s;
}

/** Space equality as the invariants mean it (I4): canonical wire form. */
export function canonical(space: GraphSpace): string {
  return encodeCanonical(space, { producer: { name: 'test', version: '0' } });
}
