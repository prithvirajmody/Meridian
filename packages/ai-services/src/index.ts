/**
 * @meridian/ai-services — the first three AI services (ROADMAP Phase 8D/8E,
 * ARCHITECTURE §8.4). Each implements an *already-existing* deterministic seam
 * and turns AI output into provenance-tagged proposals (`AbstractionProposal` /
 * `GraphProposal`) that flow through the one write path (ADR-0005/0031), never
 * a direct graph write:
 *
 * - `SummarizingAbstractionProvider` / `summarizeCut` — AI names + summaries
 *   over a deterministic grouping's rollup nodes (8D).
 * - `EmbeddingClusterer` / `clusterNodes` — deterministic clustering of a flat
 *   node soup from pluggable embeddings (8E).
 * - `StructureExtractor` / `extractStructure` — unstructured text → a validated
 *   graph proposal (8E; the P9 enabler).
 *
 * All budget/error handling degrades to the deterministic floor and leaves a
 * valid, partially-enriched result (ADR-0032). Depends on the `@meridian/ai`
 * gateway and the core IR/contract seams only (§20).
 */

// Shared structured-output schemas (§8.3)
export {
  extractedAttrValueSchema,
  extractedStructureSchema,
  proposedEdgeSchema,
  proposedNodeSchema,
  rollupSummarySchema,
} from './schemas.js';
export type {
  ExtractedStructure,
  ProposedEdge,
  ProposedNode,
  RollupSummaryOutput,
} from './schemas.js';

// AI provenance quartet (ADR-0030/0031)
export { provenanceOfCall, provenanceOfEmbed } from './provenance.js';
export type { AiProvenance } from './provenance.js';

// Failure disposition (ADR-0032)
export { classify } from './disposition.js';
export type { Disposition } from './disposition.js';

// Versioned prompt specs (§8.3)
export { SUMMARIZE_ROLLUP_PROMPT } from './prompts/summarize-rollup.js';
export type { MemberDigest, RollupPromptInput } from './prompts/summarize-rollup.js';
export { EXTRACT_STRUCTURE_PROMPT } from './prompts/extract-structure.js';
export type { ExtractPromptInput } from './prompts/extract-structure.js';

// 8D — summarizing rollup service
export { summarizeCut } from './summarize.js';
export type {
  RollupInput,
  RollupSummary,
  SummarizeCutOptions,
  SummarizeCutResult,
} from './summarize.js';
export {
  createSummarizingProvider,
  rollupOf,
  summarizeAbstraction,
  SUMMARIZING_ROLLUP_ID,
  SummarizingAbstractionProvider,
} from './provider.js';
export type { SummarizingProviderOptions } from './provider.js';

// 8E — embedding clusterer
export { clusterNodes, clustersToProposal, EmbeddingClusterer } from './cluster.js';
export type {
  Cluster,
  ClusterNodeInput,
  ClusterNodesOptions,
  ClusterResult,
} from './cluster.js';

// 8E — structure extractor (P9 enabler)
export { createStructureExtractor, extractStructure } from './extract.js';
export type {
  DomainHints,
  ExtractStructureOptions,
  ExtractStructureResult,
  GraphProposal,
  StructureExtractor,
  StructureExtractorOptions,
} from './extract.js';
