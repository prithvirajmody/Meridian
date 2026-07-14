import type {
  CompletionRequest,
  CompletionResult,
  EmbeddingRequest,
  EmbeddingResult,
  ProviderCapabilities,
  ProviderId,
} from './types.js';

/**
 * The one vendor-neutral seam every service and every session talks to. A
 * provider normalizes a concrete vendor into these calls; it throws `AiError`
 * (never a raw SDK error) and returns normalized results. `embed` is optional
 * because a completion provider may not embed — the router checks
 * `capabilities.embedding` before dispatching an embedding task (§8.2).
 */
export interface AiProvider {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;
  complete(request: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult>;
  embed?(request: EmbeddingRequest, signal?: AbortSignal): Promise<EmbeddingResult>;
}
