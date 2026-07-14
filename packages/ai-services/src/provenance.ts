/**
 * The AI provenance quartet (ADR-0030/0031): the four fields that name the
 * exact, reproducible call that produced a piece of AI output. Every service
 * stamps this onto the proposals it emits so acceptance can write it onto the
 * element's `SourceRef` (ADR-0031) — a node then reproduces the call that made
 * it, and P9 enrichment can idempotently re-run keyed by `inputHash`.
 *
 * This module holds no I/O and no vendor types; it only reshapes the gateway's
 * `AiCallResult` / `AiEmbedResult` into the neutral provenance shape.
 */
import { EMBEDDING_PROMPT_VERSION, type AiCallResult, type AiEmbedResult } from '@meridian/ai';

/** The ADR-0030 replay key, carried on AI-origin proposals and elements. */
export interface AiProvenance {
  readonly providerId: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly inputHash: string;
}

/** Extract the provenance quartet from a completed gateway completion call. */
export function provenanceOfCall(result: AiCallResult<unknown>): AiProvenance {
  return {
    providerId: result.providerId,
    model: result.model,
    promptVersion: result.promptVersion,
    inputHash: result.inputHash,
  };
}

/**
 * Extract the provenance quartet from a completed embedding call. Embeddings
 * are not rendered from a versioned `PromptSpec`, so the gateway keys them
 * under a fixed `promptVersion`; using the gateway's exported constant here
 * keeps proposal provenance identical to the session's replay key so
 * embedding-derived structure still names a reproducible call.
 */
export function provenanceOfEmbed(result: AiEmbedResult): AiProvenance {
  return {
    providerId: result.providerId,
    model: result.model,
    promptVersion: EMBEDDING_PROMPT_VERSION,
    inputHash: result.inputHash,
  };
}
