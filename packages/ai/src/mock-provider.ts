import { AiError } from './errors.js';
import type { AiProvider } from './provider.js';
import type {
  CompletionRequest,
  CompletionResult,
  EmbeddingRequest,
  EmbeddingResult,
  ProviderCapabilities,
  StopReason,
  Usage,
} from './types.js';

/** What a scripted completion should do on a given call. */
export type MockOutcome =
  | { readonly kind: 'text'; readonly text: string; readonly usage?: Partial<Usage>; readonly stopReason?: StopReason }
  | { readonly kind: 'json'; readonly value: unknown; readonly usage?: Partial<Usage>; readonly stopReason?: StopReason }
  | { readonly kind: 'refusal'; readonly usage?: Partial<Usage> }
  | { readonly kind: 'error'; readonly error: AiError };

export type MockCompletionHandler = (
  request: CompletionRequest,
  callIndex: number,
) => MockOutcome | Promise<MockOutcome>;

export type MockEmbeddingHandler = (
  request: EmbeddingRequest,
  callIndex: number,
) => readonly (readonly number[])[] | Promise<readonly (readonly number[])[]>;

export interface MockProviderOptions {
  readonly id?: string;
  readonly capabilities?: ProviderCapabilities;
  readonly onComplete?: MockCompletionHandler;
  readonly onEmbed?: MockEmbeddingHandler;
}

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  completion: true,
  embedding: false,
  models: { 'mock-model': { inputPerMTok: 1, outputPerMTok: 1 } },
};

function fillUsage(usage?: Partial<Usage>): Usage {
  return {
    inputTokens: usage?.inputTokens ?? 10,
    outputTokens: usage?.outputTokens ?? 10,
    ...(usage?.cachedInputTokens !== undefined ? { cachedInputTokens: usage.cachedInputTokens } : {}),
  };
}

/**
 * Deterministic in-process provider that drives every offline test. It records
 * each request so tests can assert what the pipeline sent, and honors
 * AbortSignal so cancellation is testable without a network.
 */
export class MockProvider implements AiProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  readonly completionRequests: CompletionRequest[] = [];
  readonly embeddingRequests: EmbeddingRequest[] = [];

  private readonly onComplete: MockCompletionHandler;
  private readonly onEmbed: MockEmbeddingHandler | undefined;

  constructor(options: MockProviderOptions = {}) {
    this.id = options.id ?? 'mock';
    this.capabilities = options.capabilities ?? DEFAULT_CAPABILITIES;
    this.onComplete =
      options.onComplete ?? (() => ({ kind: 'text', text: 'mock response' }) as MockOutcome);
    this.onEmbed = options.onEmbed;
  }

  get completionCount(): number {
    return this.completionRequests.length;
  }

  get embeddingCount(): number {
    return this.embeddingRequests.length;
  }

  async complete(request: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    if (signal?.aborted) throw new AiError('cancelled', 'Aborted before mock completion.');
    const index = this.completionRequests.length;
    this.completionRequests.push(request);
    const outcome = await this.onComplete(request, index);
    if (signal?.aborted) throw new AiError('cancelled', 'Aborted during mock completion.');

    if (outcome.kind === 'error') throw outcome.error;
    const model = request.model;
    const base = { providerId: this.id, model, raw: outcome };
    if (outcome.kind === 'refusal') {
      return { ...base, stopReason: 'refusal', usage: fillUsage(outcome.usage) };
    }
    if (outcome.kind === 'json') {
      return {
        ...base,
        // A schema-valid structured value is a successful completion. Tests
        // can still request `tool_use` explicitly when modelling that outcome.
        stopReason: outcome.stopReason ?? 'stop',
        usage: fillUsage(outcome.usage),
        structured: outcome.value,
      };
    }
    return {
      ...base,
      stopReason: outcome.stopReason ?? 'stop',
      usage: fillUsage(outcome.usage),
      text: outcome.text,
    };
  }

  async embed(request: EmbeddingRequest, signal?: AbortSignal): Promise<EmbeddingResult> {
    if (!this.onEmbed) {
      throw new AiError('unsupported', `MockProvider '${this.id}' has no embedding handler.`, {
        providerId: this.id,
      });
    }
    if (signal?.aborted) throw new AiError('cancelled', 'Aborted before mock embedding.');
    const index = this.embeddingRequests.length;
    this.embeddingRequests.push(request);
    const vectors = await this.onEmbed(request, index);
    if (signal?.aborted) throw new AiError('cancelled', 'Aborted during mock embedding.');
    return {
      providerId: this.id,
      model: request.model,
      vectors,
      usage: { inputTokens: request.input.length, outputTokens: 0 },
      raw: { vectors },
    };
  }

  /** Provider whose handler yields successive outcomes, then repeats the last. */
  static fromOutcomes(outcomes: readonly MockOutcome[], options: MockProviderOptions = {}): MockProvider {
    if (outcomes.length === 0) throw new Error('fromOutcomes requires at least one outcome.');
    return new MockProvider({
      ...options,
      onComplete: (_req, i) => outcomes[Math.min(i, outcomes.length - 1)]!,
    });
  }
}
