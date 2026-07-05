/**
 * API surface snapshot (mirrors the other packages): the runtime export set
 * is a reviewed list. Phase 3B ships level chains and cuts; 3C/3D add induced
 * edges and the resolver, which will extend this list intentionally.
 */
import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';

describe('@meridian/abstraction public surface', () => {
  it('exports exactly the committed runtime names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'CutStaleError',
      'FANOUT_CAP',
      'InducedEdgeCache',
      'WITNESS_CAP',
      'aggregateEdges',
      'buildCut',
      'buildLevelChain',
      'buildNodeCover',
      'capFanOut',
      'collectLeafPaths',
      'compareInduced',
      'countSubtreeLeaves',
      'forestRootGraphs',
      'inducedAdjacency',
      'isLeaf',
      'maxDepth',
      'memberAdjacency',
      'totalLeaves',
      'verifyCoverage',
    ]);
  });
});
