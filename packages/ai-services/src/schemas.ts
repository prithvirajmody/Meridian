/**
 * Shared zod schemas — the single source of truth for every AI service's
 * structured-output contract (§8.3). The gateway turns these into the JSON
 * Schema a provider must satisfy and validates responses against them (one
 * repair attempt, then typed rejection), so a malformed model response can
 * never reach the graph. Kinds/labels are validated for *shape* here; the
 * store's vocabulary gate (U8) is the final authority when a proposal is
 * accepted.
 */
import { z } from 'zod';

/** `ns:name`, both parts `[a-z][a-z0-9-]*` — mirrors graph-core's grammar. */
const NAMESPACED = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;

/** Attribute values an extractor may emit — scalar only (ADR-0003 subset). */
export const extractedAttrValueSchema = z.union([z.string(), z.number(), z.boolean()]);

/** The AI output for one rollup node: a short name and a one-line summary. */
export const rollupSummarySchema = z.object({
  name: z.string().min(1).max(80),
  summary: z.string().min(1).max(400),
  confidence: z.number().min(0).max(1),
});
export type RollupSummaryOutput = z.infer<typeof rollupSummarySchema>;

/** One extracted node in a {@link GraphProposal}. */
export const proposedNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.string().regex(NAMESPACED),
  label: z.string(),
  attrs: z.record(z.string().regex(NAMESPACED), extractedAttrValueSchema).optional(),
});
export type ProposedNode = z.infer<typeof proposedNodeSchema>;

/** One extracted edge in a {@link GraphProposal}. */
export const proposedEdgeSchema = z.object({
  id: z.string().min(1),
  src: z.string().min(1),
  dst: z.string().min(1),
  kind: z.string().regex(NAMESPACED),
});
export type ProposedEdge = z.infer<typeof proposedEdgeSchema>;

/**
 * The raw structured output an extractor asks the model for: nodes + edges,
 * no provenance (provenance is stamped by the service, never by the model).
 */
export const extractedStructureSchema = z.object({
  nodes: z.array(proposedNodeSchema),
  edges: z.array(proposedEdgeSchema),
});
export type ExtractedStructure = z.infer<typeof extractedStructureSchema>;
