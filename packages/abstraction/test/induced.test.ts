/**
 * Induced-edge aggregation unit tests (ADR-0013): endpoint mapping to visible
 * ancestors, internal-edge exclusion, above-cut-endpoint omission, verbatim
 * per-kind grouping, weight = Σ(w ?? 1), multiplicity, the S=3 witness cap
 * (smallest EdgeIds), deterministic `(src, dst, kind)` order, and the separate
 * fan-out cap. Hand-built spaces with known expected induced sets.
 */
import {
  addEdge,
  addGraph,
  addNode,
  asEdgeId,
  asGraphId,
  asNodeId,
  type GraphSpace,
  type NodeId,
  type SourceRef,
} from '@meridian/graph-core';
import { describe, expect, it } from 'vitest';
import { buildCut } from '../src/cut.js';
import { buildLevelChain } from '../src/level-chain.js';
import { aggregateEdges, capFanOut, WITNESS_CAP } from '../src/induced.js';

const SRC: SourceRef = { origin: 'source', uri: 'test://induced' };
const nid = (s: string): NodeId => asNodeId(s);

/**
 * Root g: P→detail gP{p1,p2}, Q→detail gQ{q1,q2}, leaf R.
 * Cross edges live in g (P,Q,R siblings); intra-group edges live in gP/gQ.
 */
function twoGroupsSpace(edges: {
  g?: [string, string, string, number?][];
  gP?: [string, string, string][];
  gQ?: [string, string, string][];
}): GraphSpace {
  let s: GraphSpace = { graphs: new Map(), roots: [] };
  for (const id of ['g', 'gP', 'gQ']) {
    s = addGraph(s, { id: asGraphId(id), label: id, domain: 'test', provenance: SRC });
  }
  s = addNode(s, asGraphId('gP'), { id: nid('p1'), kind: 'test:leaf', label: 'p1', provenance: SRC });
  s = addNode(s, asGraphId('gP'), { id: nid('p2'), kind: 'test:leaf', label: 'p2', provenance: SRC });
  s = addNode(s, asGraphId('gQ'), { id: nid('q1'), kind: 'test:leaf', label: 'q1', provenance: SRC });
  s = addNode(s, asGraphId('gQ'), { id: nid('q2'), kind: 'test:leaf', label: 'q2', provenance: SRC });
  s = addNode(s, asGraphId('g'), {
    id: nid('P'), kind: 'test:group', label: 'P', detail: { graph: asGraphId('gP') }, provenance: SRC,
  });
  s = addNode(s, asGraphId('g'), {
    id: nid('Q'), kind: 'test:group', label: 'Q', detail: { graph: asGraphId('gQ') }, provenance: SRC,
  });
  s = addNode(s, asGraphId('g'), { id: nid('R'), kind: 'test:leaf', label: 'R', provenance: SRC });

  for (const [eid, src, dst, weight] of edges.g ?? []) {
    s = addEdge(s, asGraphId('g'), {
      id: asEdgeId(eid), src: nid(src), dst: nid(dst), kind: 'rel:x',
      ...(weight !== undefined ? { weight } : {}), provenance: SRC,
    });
  }
  for (const [eid, src, dst] of edges.gP ?? []) {
    s = addEdge(s, asGraphId('gP'), { id: asEdgeId(eid), src: nid(src), dst: nid(dst), kind: 'rel:y', provenance: SRC });
  }
  for (const [eid, src, dst] of edges.gQ ?? []) {
    s = addEdge(s, asGraphId('gQ'), { id: asEdgeId(eid), src: nid(src), dst: nid(dst), kind: 'rel:y', provenance: SRC });
  }
  return s;
}

function cutAt(space: GraphSpace, level: number) {
  return buildCut(space, buildLevelChain(space), level);
}

describe('aggregateEdges — endpoint mapping', () => {
  it('maps cross edges to the visible ancestors at the coarse cut', () => {
    const space = twoGroupsSpace({
      g: [['e-pq', 'P', 'Q'], ['e-pr', 'P', 'R']],
      gP: [['e-p', 'p1', 'p2']], // internal to P at level 0
      gQ: [['e-q', 'q1', 'q2']], // internal to Q at level 0
    });
    const induced = aggregateEdges(space, cutAt(space, 0));
    expect(induced.map((e) => `${e.src}->${e.dst}:${e.kind}`)).toEqual([
      'P->Q:rel:x',
      'P->R:rel:x',
    ]);
    // Intra-group edges are internal at level 0 and excluded.
    expect(induced.every((e) => e.kind === 'rel:x')).toBe(true);
  });

  it('excludes internal edges and omits edges whose endpoint is above the cut', () => {
    const space = twoGroupsSpace({
      g: [['e-pq', 'P', 'Q'], ['e-pr', 'P', 'R']],
      gP: [['e-p', 'p1', 'p2']],
      gQ: [['e-q', 'q1', 'q2']],
    });
    // Level 1: members are the leaves {p1,p2,q1,q2,R}. P and Q are above the
    // cut, so the g-level cross edges P→Q, P→R are omitted; the once-internal
    // group edges are now cross edges between visible leaves.
    const induced = aggregateEdges(space, cutAt(space, 1));
    expect(induced.map((e) => `${e.src}->${e.dst}:${e.kind}`)).toEqual([
      'p1->p2:rel:y',
      'q1->q2:rel:y',
    ]);
  });

  it('drops self-loops as internal (A(u) === A(v))', () => {
    const space = twoGroupsSpace({ g: [['e-self', 'R', 'R']] });
    expect(aggregateEdges(space, cutAt(space, 0))).toEqual([]);
  });
});

describe('aggregateEdges — weight, multiplicity, witnesses', () => {
  it('sums weights (absent = 1), counts multiplicity, keeps the S smallest EdgeIds', () => {
    // Five parallel P→Q edges of the same kind: ids e1..e5, mixed weights.
    const space = twoGroupsSpace({
      g: [
        ['e5', 'P', 'Q', 2],
        ['e3', 'P', 'Q'], // absent weight ⇒ 1
        ['e1', 'P', 'Q', 4],
        ['e4', 'P', 'Q', 3],
        ['e2', 'P', 'Q'], // absent ⇒ 1
      ],
    });
    const induced = aggregateEdges(space, cutAt(space, 0));
    expect(induced).toHaveLength(1);
    const e = induced[0]!;
    expect(e.multiplicity).toBe(5);
    expect(e.weight).toBe(2 + 1 + 4 + 3 + 1); // 11
    expect(e.samples).toHaveLength(WITNESS_CAP);
    expect(e.samples).toEqual(['e1', 'e2', 'e3']); // three smallest EdgeIds
  });

  it('keeps verbatim kinds distinct between the same visible pair', () => {
    let space = twoGroupsSpace({ g: [['e-x', 'P', 'Q']] });
    space = addEdge(space, asGraphId('g'), {
      id: asEdgeId('e-z'), src: nid('P'), dst: nid('Q'), kind: 'rel:z', provenance: SRC,
    });
    const induced = aggregateEdges(space, cutAt(space, 0));
    expect(induced.map((e) => e.kind)).toEqual(['rel:x', 'rel:z']); // two induced edges
  });
});

describe('aggregateEdges — determinism', () => {
  it('is byte-identical across repeated runs (I6)', () => {
    const space = twoGroupsSpace({ g: [['e-pq', 'P', 'Q'], ['e-pr', 'P', 'R']] });
    const cut = cutAt(space, 0);
    expect(JSON.stringify(aggregateEdges(space, cut))).toEqual(JSON.stringify(aggregateEdges(space, cut)));
  });

  it('returns [] for an empty graph', () => {
    const empty: GraphSpace = { graphs: new Map(), roots: [] };
    expect(aggregateEdges(empty, buildCut(empty, buildLevelChain(empty), 0))).toEqual([]);
  });
});

describe('capFanOut — labeled post-aggregation truncation', () => {
  it('keeps the top-M by weight and folds the rest into one residual', () => {
    // Hub H with 5 out-edges of descending weight; cap at 3.
    const edges = [1, 2, 3, 4, 5].map((w, i) => ({
      src: nid('H'),
      dst: nid(`d${i}`),
      kind: 'rel:x',
      weight: w,
      multiplicity: 1,
      samples: [asEdgeId(`e${i}`)],
    }));
    const { edges: kept, residuals } = capFanOut(edges, 3);
    expect(kept).toHaveLength(3);
    expect(kept.map((e) => e.weight).sort((a, b) => a - b)).toEqual([3, 4, 5]); // heaviest kept
    expect(residuals).toHaveLength(1);
    expect(residuals[0]).toMatchObject({ node: 'H', direction: 'out', hidden: 2, weight: 1 + 2, multiplicity: 2 });
  });

  it('is a no-op when every degree is within budget', () => {
    const edges = [
      { src: nid('a'), dst: nid('b'), kind: 'rel:x', weight: 1, multiplicity: 1, samples: [] },
    ];
    expect(capFanOut(edges, 32)).toEqual({ edges, residuals: [] });
  });
});
