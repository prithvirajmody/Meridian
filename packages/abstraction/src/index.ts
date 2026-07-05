/**
 * @meridian/abstraction — the abstraction engine (ROADMAP Phase 3). Phase 3B
 * ships level chains and cuts (the covering antichain, I5); Phase 3C adds
 * induced-edge aggregation (ADR-0013) and its incremental cache; the node
 * budget and the LOD resolver follow in 3D. Pure functions over immutable
 * `GraphSpace` snapshots (P8); imports graph-core / graph-store only (§20
 * dependency law).
 */
export type { Cut, CutMember, CutReason, CoverageProof, CoverageResult } from './cut.js';
export { buildCut, verifyCoverage } from './cut.js';
export type { CappedFanOut, FanOutResidual, InducedEdge } from './induced.js';
export {
  aggregateEdges,
  buildNodeCover,
  capFanOut,
  compareInduced,
  FANOUT_CAP,
  inducedAdjacency,
  memberAdjacency,
  WITNESS_CAP,
} from './induced.js';
export { CutStaleError, InducedEdgeCache } from './induced-cache.js';
export type { LeafPath } from './forest.js';
export {
  collectLeafPaths,
  countSubtreeLeaves,
  forestRootGraphs,
  isLeaf,
  maxDepth,
  totalLeaves,
} from './forest.js';
export type { LevelChain, LevelChainSpec, LevelInfo, LevelSpec } from './level-chain.js';
export { buildLevelChain } from './level-chain.js';
