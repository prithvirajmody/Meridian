import { describe, expect, it } from 'vitest';
import {
  normalizeOpenAiError,
  OpenAiProvider,
  type OpenAiChatCompletion,
  type OpenAiChatParams,
  type OpenAiClient,
  type OpenAiEmbeddingResponse,
} from '../../src/providers/openai.js';
import type { CompletionRequest, ProviderCapabilities } from '../../src/types.js';

const CAPS: ProviderCapabilities = {
  completion: true,
  embedding: true,
  models: {
    'gpt-x': { inputPerMTok: 2, outputPerMTok: 8 },
    emb: { inputPerMTok: 0.1, outputPerMTok: 0 },
  },
};

interface ChatState {
  params?: OpenAiChatParams;
  options?: { signal?: AbortSignal };
}

function fakeChat(completion: OpenAiChatCompletion): { client: OpenAiClient; state: ChatState } {
  const state: ChatState = {};
  const client: OpenAiClient = {
    chat: {
      completions: {
        create: (params, options) => {
          state.params = params;
          state.options = options;
          return Promise.resolve(completion);
        },
      },
    },
    embeddings: { create: () => Promise.reject(new Error('unused')) },
  };
  return { client, state };
}

const structuredRequest: CompletionRequest = {
  model: 'gpt-x',
  system: 'sys',
  messages: [{ role: 'user', content: 'hi' }],
  maxOutputTokens: 100,
  // A closed object with every property required — inside OpenAI's strict subset.
  outputSchema: {
    type: 'object',
    properties: { name: { type: 'string' }, summary: { type: 'string' } },
    required: ['name', 'summary'],
    additionalProperties: false,
  },
  temperature: 0.2,
};

describe('OpenAiProvider.complete — structured output', () => {
  it('requests a json_schema response format and parses the content', async () => {
    const completion: OpenAiChatCompletion = {
      id: 'c1',
      model: 'gpt-x',
      choices: [
        { index: 0, message: { role: 'assistant', content: '{"name":"N","summary":"S"}' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
    };
    const fake = fakeChat(completion);
    const provider = new OpenAiProvider({ capabilities: CAPS, client: fake.client });
    const controller = new AbortController();
    const result = await provider.complete(structuredRequest, controller.signal);

    expect(result.structured).toEqual({ name: 'N', summary: 'S' });
    expect(result.stopReason).toBe('stop');
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 7 });

    expect(fake.state.params?.response_format?.type).toBe('json_schema');
    expect(fake.state.params?.response_format?.json_schema.schema).toEqual(
      structuredRequest.outputSchema,
    );
    expect(fake.state.params?.response_format?.json_schema.strict).toBe(true);
    expect(fake.state.params?.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(fake.state.params?.max_completion_tokens).toBe(100);
    expect(fake.state.options?.signal).toBe(controller.signal);
  });

  it('maps a refusal field to a refusal stop reason', async () => {
    const completion: OpenAiChatCompletion = {
      id: 'c2',
      model: 'gpt-x',
      choices: [{ index: 0, message: { role: 'assistant', content: null, refusal: 'no' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
    };
    const provider = new OpenAiProvider({ capabilities: CAPS, client: fakeChat(completion).client });
    const result = await provider.complete(structuredRequest);
    expect(result.stopReason).toBe('refusal');
    expect(result.structured).toBeUndefined();
  });

  it('maps content_filter to the same refusal outcome', async () => {
    const completion: OpenAiChatCompletion = {
      id: 'c-filtered',
      model: 'gpt-x',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '{"name":"partial"}' },
        finish_reason: 'content_filter',
      }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    };
    const provider = new OpenAiProvider({ capabilities: CAPS, client: fakeChat(completion).client });
    const result = await provider.complete(structuredRequest);
    expect(result.stopReason).toBe('refusal');
    expect(result.structured).toBeUndefined();
  });
});

describe('OpenAiProvider.complete — text output', () => {
  it('returns text and maps length to max_tokens; omits the system message when absent', async () => {
    const completion: OpenAiChatCompletion = {
      id: 'c3',
      model: 'gpt-x',
      choices: [{ index: 0, message: { role: 'assistant', content: 'plain text' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    };
    const fake = fakeChat(completion);
    const provider = new OpenAiProvider({ capabilities: CAPS, client: fake.client });
    const result = await provider.complete({
      model: 'gpt-x',
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 50,
    });
    expect(result.text).toBe('plain text');
    expect(result.stopReason).toBe('max_tokens');
    expect(fake.state.params?.messages[0]?.role).toBe('user');
    expect(fake.state.params?.response_format).toBeUndefined();
  });
});

describe('OpenAiProvider.embed', () => {
  it('orders vectors by index and reports usage', async () => {
    const response: OpenAiEmbeddingResponse = {
      model: 'emb',
      data: [
        { index: 1, embedding: [0.2] },
        { index: 0, embedding: [0.1] },
      ],
      usage: { prompt_tokens: 2, total_tokens: 2 },
    };
    const client: OpenAiClient = {
      chat: { completions: { create: () => Promise.reject(new Error('unused')) } },
      embeddings: { create: () => Promise.resolve(response) },
    };
    const provider = new OpenAiProvider({ capabilities: CAPS, client });
    const result = await provider.embed({ model: 'emb', input: ['a', 'b'] });
    expect(result.vectors).toEqual([[0.1], [0.2]]);
    expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 0 });
  });
});

describe('normalizeOpenAiError', () => {
  it('maps statuses and transport faults', () => {
    expect(normalizeOpenAiError({ status: 429 }, 'openai', 'gpt-x').kind).toBe('provider_transient');
    expect(normalizeOpenAiError({ status: 500 }, 'openai', 'gpt-x').kind).toBe('provider_transient');
    expect(normalizeOpenAiError({ status: 400 }, 'openai', 'gpt-x').kind).toBe('provider_fatal');
    expect(normalizeOpenAiError({ name: 'AbortError' }, 'openai', 'gpt-x').kind).toBe('cancelled');
    expect(normalizeOpenAiError({}, 'openai', 'gpt-x').kind).toBe('provider_transient');
  });
});
