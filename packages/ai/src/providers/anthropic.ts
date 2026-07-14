import { AiError } from '../errors.js';
import type { AiProvider } from '../provider.js';
import type {
  CompletionRequest,
  CompletionResult,
  ProviderCapabilities,
  StopReason,
  Usage,
} from '../types.js';

/**
 * The exact slice of the Anthropic Messages API this adapter calls. The real
 * SDK client (constructed in ./anthropic-client.ts, the only module that
 * imports the SDK) is structurally assignable to this; tests inject a fake that
 * implements it — so all adapter logic is exercised with zero network (§20).
 */
export interface AnthropicMessagesClient {
  readonly messages: {
    create(
      params: AnthropicCreateParams,
      options?: { readonly signal?: AbortSignal },
    ): Promise<AnthropicMessage>;
  };
}

export interface AnthropicCreateParams {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  temperature?: number;
  stop_sequences?: string[];
  tools?: Array<{ name: string; description?: string; input_schema: Record<string, unknown> }>;
  tool_choice?: { type: 'tool'; name: string } | { type: 'auto' } | { type: 'any' };
}

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

export interface AnthropicMessage {
  id: string;
  model: string;
  role: 'assistant';
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'refusal' | null;
  content: AnthropicContentBlock[];
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number };
}

/** Forced-tool name used to coerce structured JSON output. */
const STRUCTURED_TOOL = 'emit_structured_result';

export interface AnthropicProviderOptions {
  readonly id?: string;
  readonly capabilities: ProviderCapabilities;
  readonly client: AnthropicMessagesClient;
}

/**
 * Anthropic completion provider. Structured output is obtained via a forced
 * tool call whose `input_schema` is the caller's JSON Schema; the tool input is
 * the structured result. Anthropic does not embed, so `embed` is absent and
 * `capabilities.embedding` must be false (§8.2).
 */
export class AnthropicProvider implements AiProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  private readonly client: AnthropicMessagesClient;

  constructor(options: AnthropicProviderOptions) {
    this.id = options.id ?? 'anthropic';
    this.capabilities = options.capabilities;
    this.client = options.client;
  }

  async complete(request: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    const params: AnthropicCreateParams = {
      model: request.model,
      max_tokens: request.maxOutputTokens,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (request.system !== undefined) params.system = request.system;
    if (request.temperature !== undefined) params.temperature = request.temperature;
    if (request.stopSequences !== undefined) params.stop_sequences = [...request.stopSequences];
    if (request.outputSchema !== undefined) {
      params.tools = [
        {
          name: STRUCTURED_TOOL,
          description: 'Return the result as structured JSON matching the schema.',
          input_schema: request.outputSchema,
        },
      ];
      params.tool_choice = { type: 'tool', name: STRUCTURED_TOOL };
    }

    let message: AnthropicMessage;
    try {
      message = await this.client.messages.create(params, signal ? { signal } : undefined);
    } catch (error) {
      throw normalizeAnthropicError(error, this.id, request.model);
    }
    return this.normalize(message, request);
  }

  private normalize(message: AnthropicMessage, request: CompletionRequest): CompletionResult {
    const usage: Usage = {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      ...(message.usage.cache_read_input_tokens !== undefined
        ? { cachedInputTokens: message.usage.cache_read_input_tokens }
        : {}),
    };
    const mappedStopReason = mapStopReason(message.stop_reason);
    const base = {
      providerId: this.id,
      model: message.model,
      stopReason: mappedStopReason,
      usage,
      raw: message,
    };

    if (request.outputSchema !== undefined) {
      const tool = message.content.find(
        (block): block is Extract<AnthropicContentBlock, { type: 'tool_use' }> =>
          block.type === 'tool_use' && block.name === STRUCTURED_TOOL,
      );
      // A refusal (or a model that emitted no tool call) leaves `structured`
      // undefined; the session's zod validation then drives the repair path.
      // The forced tool is an adapter implementation detail. Once it produced
      // the requested structured value, expose the same successful `stop`
      // reason as providers with native JSON-schema output.
      const stopReason = tool !== undefined && mappedStopReason === 'tool_use'
        ? 'stop'
        : mappedStopReason;
      return { ...base, stopReason, structured: tool?.input };
    }

    const text = message.content
      .filter((block): block is Extract<AnthropicContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('');
    return { ...base, text };
  }
}

function mapStopReason(reason: AnthropicMessage['stop_reason']): StopReason {
  switch (reason) {
    case 'end_turn':
      return 'stop';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    case 'tool_use':
      return 'tool_use';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

interface StatusError {
  status?: number;
  name?: string;
  message?: string;
}

/** Map an SDK/transport error to the normalized `AiError` currency. */
export function normalizeAnthropicError(error: unknown, providerId: string, model: string): AiError {
  const e = (error ?? {}) as StatusError;
  const context = { providerId, model, status: e.status, raw: error };

  if (e.name && /abort/i.test(e.name)) {
    return new AiError('cancelled', 'Anthropic request aborted.', context, { cause: error });
  }
  const status = e.status;
  if (status === 429 || status === 529 || status === 408 || (status !== undefined && status >= 500)) {
    return new AiError('provider_transient', `Anthropic transient error (status ${status}).`, context, {
      cause: error,
    });
  }
  if (status !== undefined && status >= 400) {
    return new AiError('provider_fatal', `Anthropic request failed (status ${status}).`, context, {
      cause: error,
    });
  }
  // No status → treat as a transport/network fault, which is retryable.
  return new AiError('provider_transient', 'Anthropic network error.', context, { cause: error });
}
