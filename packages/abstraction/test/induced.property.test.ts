/**
 * Induced-edge equivalence property (ROADMAP Phase 3 §12): for random forests
 * with random intra-graph edges and every base level, `aggregateEdges` matches
 * an **independent** brute-force aggregator. The brute force shares no code
 * with the production path — it maps endpoints to visible ancestors by an
 * explicit root→node path walk (not the pre-order inheritance `buildNodeCover`
 * uses) and re-derives every group from scratch — so the property tests the
 * algorithm, not the implementation against itself.
 */
import {
  derivedRootsOf,
  type EdgeId,
  type GraphSpace,
  type NodeId,
  type SemanticGraph,
} from '@meridian/graph-core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildCut, type Cut } from '../src/cut.js';
import { buildLevelChain } from '../src/level-chain.js';
import { aggregateEdges, type InducedEdge, WITNESS_CAP } from '../src/induced.js';
import { forestSpaceWithEdgesArb } from './arbitraries.js';

const WITNESS = WITNESS_CAP;

/** Independent brute force. Records every node's full root→node ancestor
 * chain by walking containment directly, then `A(x)` is the deepest cut member
 * on that chain (scanning bottom-up). Groups are rebuilt with plain objects
 * and finished by re-sorting — deliberately nothing in common with the
 * production grouping/cover code. */
function bruteAggregate(space: GraphSpace, cut: Cut): InducedEdge[] {
  const members = new Set<NodeId>(cut.members);
  const chainOf = new Map<NodeId, NodeId[]>();

  const walk = (graph: SemanticGraph, prefix: NodeId[]): void => {
    for (const node of graph.nodes.values()) {
      const chain = [...prefix, node.id];
      chainOf.set(node.id, chain);
      const detail = node.detail ? space.graphs.get(node.detail.graph) : undefined;
      if (detail !== undefined && detail.nodes.size > 0) walk(detail, chain);
    }
  };
  for (const rootId of derivedRootsOf(space)) {
    const root = space.graphs.get(rootId);
    if (root !== undefined) walk(root, []);
  }

  const visibleAncestor = (x: NodeId): NodeId | undefined => {
    const chain = chainOf.get(x);
    if (chain === undefined) return undefined;
    for (let i = chain.length - 1; i >= 0; i--) {
      if (members.has(chain[i]!)) return chain[i];
    }
    return undefined;
  };

  interface Acc {
    src: NodeId;
    dst: NodeId;
    kind: string;
    weight: number;
    multiplicity: number;
    ids: EdgeId[];
  }
  const acc = new Map<string, Acc>();
  for (const graph of space.graphs.values()) {
    for (const edge of graph.edges.values()) {
      const s = visibleAncestor(edge.src);
      const d = visibleAncestor(edge.dst);
      if (s === undefined || d === undefined || s === d) continue;
      const key = JSON.stringify([s, d, edge.kind]);
      let group = acc.get(key);
      if (group === undefined) {
        group = { src: s, dst: d, kind: edge.kind, weight: 0, multiplicity: 0, ids: [] };
        acc.set(key, group);
      }
      group.weight += edge.weight ?? 1;
      group.multiplicity += 1;
      group.ids.push(edge.id);
    }
  }

  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return [...acc.values()]
    .map((g): InducedEdge => ({
      src: g.src,
      dst: g.dst,
      kind: g.kind,
      weight: g.weight,
      multiplicity: g.multiplicity,
      samples: [...g.ids].sort(cmp).slice(0, WITNESS),
    }))
    .sort((a, b) => cmp(a.src, b.src) || cmp(a.dst, b.dst) || cmp(a.kind, b.kind));
}

/** All base levels worth exercising for a space (0 through maxDepth + 1). */
const levelsArb = (space: GraphSpace): fc.Arbitrary<number> => {
  let deepest = 0;
  const scan = (graph: SemanticGraph, depth: number): void => {
    for (const node of graph.nodes.values()) {
      if (depth > deepest) deepest = depth;
      const detail = node.detail ? space.graphs.get(node.detail.graph) : undefined;
      if (detail !== undefined && detail.nodes.size > 0) scan(detail, depth + 1);
    }
  };
  for (const id of derivedRootsOf(space)) {
    const g = space.graphs.get(id);
    if (g) scan(g, 0);
  }
  return fc.nat(deepest + 1);
};

describe('induced edges vs. independent brute force (equivalence property)', () => {
  it('matches for random forests, random edges, every level', () => {
    fc.assert(
      fc.property(
        forestSpaceWithEdgesArb.chain((space) => levelsArb(space).map((level) => ({ space, level }))),
        ({ space, level }) => {
          const cut = buildCut(space, buildLevelChain(space), level);
          const actual = aggregateEdges(space, cut);
          const expected = bruteAggregate(space, cut);
          expect(actual).toEqual(expected);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('is byte-identical across two runs on the same inputs (I6 determinism)', () => {
    fc.assert(
      fc.property(
        forestSpaceWithEdgesArb.chain((space) => levelsArb(space).map((level) => ({ space, level }))),
        ({ space, level }) => {
          const cut = buildCut(space, buildLevelChain(space), level);
          expect(JSON.stringify(aggregateEdges(space, cut))).toEqual(
            JSON.stringify(aggregateEdges(space, cut)),
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
