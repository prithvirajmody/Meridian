import { AiError } from '../errors.js';
import type { AiProvider } from '../provider.js';
import type {
  CompletionRequest,
  CompletionResult,
  EmbeddingRequest,
  EmbeddingResult,
  JsonSchema,
  ProviderCapabilities,
  StopReason,
  Usage,
} from '../types.js';

/**
 * The slice of the OpenAI SDK this adapter calls. The real client (constructed
 * in ./openai-client.ts, the only module importing `openai`) is structurally
 * assignable; tests inject a fake (§20). OpenAI both completes and embeds, so
 * this provider exercises the independent-embedding-route path (§8.2).
 */
export interface OpenAiClient {
  readonly chat: {
    readonly completions: {
      create(
        params: OpenAiChatParams,
        options?: { readonly signal?: AbortSignal },
      ): Promise<OpenAiChatCompletion>;
    };
  };
  readonly embeddings: {
    create(
      params: OpenAiEmbeddingParams,
      options?: { readonly signal?: AbortSignal },
    ): Promise<OpenAiEmbeddingResponse>;
  };
}

export interface OpenAiChatParams {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  max_completion_tokens?: number;
  temperature?: number;
  stop?: string[];
  response_format?: {
    type: 'json_schema';
    json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean };
  };
}

export interface OpenAiChatCompletion {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string | null; refusal?: string | null };
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call' | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface OpenAiEmbeddingParams {
  model: string;
  input: string[];
}

export interface OpenAiEmbeddingResponse {
  model: string;
  data: Array<{ index: number; embedding: number[] }>;
  usage?: { prompt_tokens: number; total_tokens: number };
}

const STRUCTURED_SCHEMA_NAME = 'structured_result';

/**
 * Validation keywords that OpenAI's strict Structured Outputs does not accept.
 * Their presence anywhere in a schema forces the non-strict request shape.
 */
const STRICT_UNSUPPORTED_KEYWORDS: readonly string[] = [
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
];

/**
 * OpenAI Structured Outputs with `strict: true` accepts only a subset of JSON
 * Schema: every object must pin `additionalProperties: false` and list *all* of
 * its properties in `required`, and it rejects open dictionaries
 * (schema-valued `additionalProperties`), `propertyNames`, and the validation
 * keywords above. Anthropic's tool `input_schema` accepts the full schema, so
 * this narrowing is deliberately provider-local — the shared schemas that
 * legitimately use optionals, open `z.record` maps, and value bounds are never
 * weakened. When a schema falls outside the strict subset the adapter sends it
 * with `strict: false`: OpenAI still steers generation toward the schema, and
 * the gateway's zod validation + one repair stay authoritative on shape (§8.3).
 */
export function isOpenAiStrictCompatible(schema: JsonSchema): boolean {
  return strictViolation(schema) === null;
}

/** First reason `node` cannot be sent as strict Structured Outputs, else null. */
function strictViolation(node: unknown): string | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const reason = strictViolation(item);
      if (reason !== null) return reason;
    }
    return null;
  }
  if (node === null || typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const keyword of STRICT_UNSUPPORTED_KEYWORDS) {
    if (keyword in obj) return keyword;
  }

  const isObjectSchema =
    obj['type'] === 'object' ||
    'properties' in obj ||
    'additionalProperties' in obj ||
    'propertyNames' in obj;
  if (isObjectSchema) {
    if ('propertyNames' in obj) return 'propertyNames';
    // Missing or schema-valued `additionalProperties` = an open/free-form
    // object (e.g. a `z.record` dictionary) — strict requires exactly `false`.
    if (obj['additionalProperties'] !== false) return 'additionalProperties';
    const properties = obj['properties'];
    if (properties !== null && typeof properties === 'object') {
      const required = Array.isArray(obj['required']) ? (obj['required'] as unknown[]) : [];
      const requiredSet = new Set(required.map((r) => String(r)));
      for (const key of Object.keys(properties as Record<string, unknown>)) {
        if (!requiredSet.has(key)) return 'optional-property';
      }
    }
  }

  for (const value of Object.values(obj)) {
    const reason = strictViolation(value);
    if (reason !== null) return reason;
  }
  return null;
}

export interface OpenAiProviderOptions {
  readonly id?: string;
  readonly capabilities: ProviderCapabilities;
  readonly client: OpenAiClient;
}

export class OpenAiProvider implements AiProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  private readonly client: OpenAiClient;

  constructor(options: OpenAiProviderOptions) {
    this.id = options.id ?? 'openai';
    this.capabilities = options.capabilities;
    this.client = options.client;
  }

  async complete(request: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    const messages: OpenAiChatParams['messages'] = [];
    if (request.system !== undefined) messages.push({ role: 'system', content: request.system });
    for (const m of request.messages) messages.push({ role: m.role, content: m.content });

    const params: OpenAiChatParams = {
      model: request.model,
      messages,
      max_completion_tokens: request.maxOutputTokens,
    };
    if (request.temperature !== undefined) params.temperature = request.temperature;
    if (request.stopSequences !== undefined) params.stop = [...request.stopSequences];
    if (request.outputSchema !== undefined) {
      // `strict: true` only for schemas OpenAI's strict subset can represent;
      // otherwise send the schema non-strict so the request is accepted, and
      // let the gateway's zod validation + one repair enforce shape (§8.3).
      params.response_format = {
        type: 'json_schema',
        json_schema: {
          name: STRUCTURED_SCHEMA_NAME,
          schema: request.outputSchema,
          strict: isOpenAiStrictCompatible(request.outputSchema),
        },
      };
    }

    let completion: OpenAiChatCompletion;
    try {
      completion = await this.client.chat.completions.create(params, signal ? { signal } : undefined);
    } catch (error) {
      throw normalizeOpenAiError(error, this.id, request.model);
    }
    return this.normalize(completion, request);
  }

  async embed(request: EmbeddingRequest, signal?: AbortSignal): Promise<EmbeddingResult> {
    let response: OpenAiEmbeddingResponse;
    try {
      response = await this.client.embeddings.create(
        { model: request.model, input: [...request.input] },
        signal ? { signal } : undefined,
      );
    } catch (error) {
      throw normalizeOpenAiError(error, this.id, request.model);
    }
    const vectors = [...response.data]
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
    const usage: Usage = {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: 0,
    };
    return { providerId: this.id, model: response.model, vectors, usage, raw: response };
  }

  private normalize(completion: OpenAiChatCompletion, request: CompletionRequest): CompletionResult {
    const choice = completion.choices[0];
    const usage: Usage = {
      inputTokens: completion.usage?.prompt_tokens ?? 0,
      outputTokens: completion.usage?.completion_tokens ?? 0,
    };
    const refusalText = choice?.message.refusal;
    const refused = refusalText != null && refusalText !== '';
    const stopReason: StopReason = refused
      ? 'refusal'
      : mapFinishReason(choice?.finish_reason ?? null);
    const base = { providerId: this.id, model: completion.model, stopReason, usage, raw: completion };

    const content = choice?.message.content ?? '';
    if (request.outputSchema !== undefined) {
      // A refusal or empty content leaves `structured` undefined; the session's
      // zod validation drives the repair path.
      let structured: unknown;
      if (stopReason !== 'refusal' && content !== '') {
        try {
          structured = JSON.parse(content) as unknown;
        } catch {
          structured = undefined;
        }
      }
      return { ...base, structured };
    }
    return { ...base, text: content };
  }
}

function mapFinishReason(reason: OpenAiChatCompletion['choices'][number]['finish_reason']): StopReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      // Filtering is a provider-enforced refusal, not a successful/truncated
      // completion. Normalize it to the same service-visible outcome as an
      // explicit refusal field.
      return 'refusal';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    default:
      return 'other';
  }
}

interface StatusError {
  status?: number;
  name?: string;
  message?: string;
}

export function normalizeOpenAiError(error: unknown, providerId: string, model: string): AiError {
  const e = (error ?? {}) as StatusError;
  const context = { providerId, model, status: e.status, raw: error };

  if (e.name && /abort/i.test(e.name)) {
    return new AiError('cancelled', 'OpenAI request aborted.', context, { cause: error });
  }
  const status = e.status;
  if (status === 429 || status === 408 || (status !== undefined && status >= 500)) {
    return new AiError('provider_transient', `OpenAI transient error (status ${status}).`, context, {
      cause: error,
    });
  }
  if (status !== undefined && status >= 400) {
    return new AiError('provider_fatal', `OpenAI request failed (status ${status}).`, context, {
      cause: error,
    });
  }
  return new AiError('provider_transient', 'OpenAI network error.', context, { cause: error });
}
