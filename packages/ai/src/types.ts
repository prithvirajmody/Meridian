/**
 * Vendor-neutral gateway vocabulary. Every provider normalizes its wire shapes
 * into these types; nothing above the provider adapters ever sees a vendor SDK
 * type (§20). JSON Schema is the only structured-output currency crossing into
 * a provider — zod stays on the AiSession side of the boundary.
 */

export type ProviderId = string;
export type ModelId = string;

/**
 * Task classes the gateway routes on (ARCHITECTURE §8.2). Completion classes
 * route to a completion provider+model; `embedding` routes independently
 * because a completion provider may not embed at all.
 */
export type TaskClass = 'extraction' | 'summarization' | 'bulk-label' | 'embedding';

export type Role = 'user' | 'assistant';

export interface Message {
  readonly role: Role;
  readonly content: string;
}

/** Normalized stop reason across vendors. */
export type StopReason =
  | 'stop' // natural completion
  | 'max_tokens' // truncated by the output cap
  | 'tool_use' // model emitted a tool call not consumed as structured output
  | 'stop_sequence' // hit a caller stop sequence
  | 'refusal' // model declined to answer
  | 'content_filter' // filtered by the provider
  | 'other';

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Prompt tokens served from the provider's prompt cache, when reported. */
  readonly cachedInputTokens?: number;
}

/** JSON Schema — structural; we only ever produce/consume plain JSON here. */
export type JsonSchema = Record<string, unknown>;

/**
 * A completion request as a provider sees it: already rendered from a
 * PromptSpec, model resolved by routing. When `outputSchema` is present the
 * provider must return JSON conforming to it (structured output).
 */
export interface CompletionRequest {
  readonly model: ModelId;
  readonly system?: string;
  readonly messages: readonly Message[];
  readonly maxOutputTokens: number;
  readonly outputSchema?: JsonSchema;
  readonly temperature?: number;
  readonly stopSequences?: readonly string[];
}

export interface CompletionResult {
  readonly providerId: ProviderId;
  readonly model: ModelId;
  readonly stopReason: StopReason;
  readonly usage: Usage;
  /** Free-text output (absent for pure structured-output calls). */
  readonly text?: string;
  /** Parsed structured output (present iff `outputSchema` was requested). */
  readonly structured?: unknown;
  /** Raw provider payload, retained for diagnostics and record/replay. */
  readonly raw: unknown;
}

export interface EmbeddingRequest {
  readonly model: ModelId;
  readonly input: readonly string[];
}

export interface EmbeddingResult {
  readonly providerId: ProviderId;
  readonly model: ModelId;
  readonly vectors: readonly (readonly number[])[];
  readonly usage: Usage;
  readonly raw: unknown;
}

/** Per-model cost metadata, in dollars per 1,000,000 tokens. */
export interface ModelPricing {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
}

/**
 * A provider's self-description: which task classes it supports, its model
 * catalog, and whether it embeds. The router consults this before dispatch.
 */
export interface ProviderCapabilities {
  readonly completion: boolean;
  readonly embedding: boolean;
  /** Concrete model ids this provider will accept, with pricing. */
  readonly models: Readonly<Record<ModelId, ModelPricing>>;
}
