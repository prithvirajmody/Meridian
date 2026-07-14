/**
 * Versioned prompt for extracting a small graph (nodes + typed edges) from a
 * span of text (subphase 8E — the P9 enabler). The model returns only the
 * structure; provenance is stamped by the service, never asked of the model.
 * See {@link SUMMARIZE_ROLLUP_PROMPT} for the versioning contract.
 */
import { definePromptSpec, type PromptSpec } from '@meridian/ai';
import { extractedStructureSchema, type ExtractedStructure } from '../schemas.js';

/** The deterministic projection the extractor prompt renders from. */
export interface ExtractPromptInput {
  /** The domain the caller wants ids/kinds namespaced under (e.g. `arg`). */
  readonly domain: string;
  /** The source text to extract structure from. */
  readonly text: string;
}

export const EXTRACT_STRUCTURE_PROMPT: PromptSpec<ExtractPromptInput, ExtractedStructure> =
  definePromptSpec<ExtractPromptInput, ExtractedStructure>({
    id: 'ai-services:extract-structure',
    version: '1',
    taskClass: 'extraction',
    schema: extractedStructureSchema,
    maxOutputTokens: 2048,
    temperature: 0,
    render: (input) => ({
      system:
        'You extract a small typed graph from text. Identify the salient entities ' +
        'as nodes and the relationships between them as directed edges. ' +
        `Every node id, node kind, and edge kind must be namespaced as "${input.domain}:name" ` +
        'with lowercase [a-z0-9-] parts. Edge src/dst must reference node ids you emit. ' +
        'Use only what the text supports; do not invent entities or relations.',
      messages: [{ role: 'user', content: input.text }],
    }),
  });
