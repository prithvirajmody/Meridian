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
      'BUILTIN_ABSTRACTION_PROVIDERS',
      'CONTAINMENT_ROLLUP_ID',
      'CutStaleError',
      'DEFAULT_SALIENCE_WEIGHTS',
      'DEGREE_COLLAPSE_ID',
      'FANOUT_CAP',
      'InducedEdgeCache',
      'LodResolver',
      'SALIENCE_ATTR',
      'UPDATED_AT_ATTR',
      'WITNESS_CAP',
      'aggregateEdges',
      'applyProposal',
      'assertValidPolicy',
      'buildCut',
      'buildForestIndex',
      'buildLevelChain',
      'buildNodeCover',
      'capFanOut',
      'collectLeafPaths',
      'compareInduced',
      'computeSalience',
      'containmentRollupProvider',
      'countSubtreeLeaves',
      'degreeSizeCollapseProvider',
      'forestRootGraphs',
      'inducedAdjacency',
      'isLeaf',
      'isLeafNode',
      'levelForZoom',
      'maxDepth',
      'maxLevelOf',
      'memberAdjacency',
      'nominalLevel',
      'resolveLod',
      'totalLeaves',
      'verifyCoverage',
    ]);
  });
});
