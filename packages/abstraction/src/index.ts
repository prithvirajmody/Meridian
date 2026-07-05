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
export type { Budget, LevelResolution, ZoomPolicy } from './zoom-policy.js';
export { assertValidPolicy, levelForZoom, maxLevelOf, nominalLevel } from './zoom-policy.js';
export type { ForestIndex } from './forest-index.js';
export { buildForestIndex, isLeafNode, SALIENCE_ATTR, UPDATED_AT_ATTR } from './forest-index.js';
export type { SalienceWeights } from './salience.js';
export { computeSalience, DEFAULT_SALIENCE_WEIGHTS } from './salience.js';
export type {
  BudgetCollapse,
  BudgetTrace,
  CutTrace,
  IgnoredOverride,
  LodRequest,
  LodResolverOptions,
  LodResult,
  OverrideKind,
} from './resolver.js';
export { LodResolver, resolveLod } from './resolver.js';
export type {
  AbstractionContext,
  AbstractionProposal,
  AbstractionProvider,
  ProposedGroup,
  ProviderLogger,
} from './providers.js';
export {
  BUILTIN_ABSTRACTION_PROVIDERS,
  containmentRollupProvider,
  CONTAINMENT_ROLLUP_ID,
  DEGREE_COLLAPSE_ID,
  degreeSizeCollapseProvider,
} from './providers.js';
export type { ApplyProposalOptions, ApplyProposalResult, ProposalIssue } from './apply-proposal.js';
export { applyProposal } from './apply-proposal.js';
