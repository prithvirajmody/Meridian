import { describe, expect, it } from 'vitest';
import {
  AnthropicProvider,
  normalizeAnthropicError,
  type AnthropicCreateParams,
  type AnthropicMessage,
  type AnthropicMessagesClient,
} from '../../src/providers/anthropic.js';
import type { CompletionRequest, ProviderCapabilities } from '../../src/types.js';

const CAPS: ProviderCapabilities = {
  completion: true,
  embedding: false,
  models: { 'claude-x': { inputPerMTok: 15, outputPerMTok: 75 } },
};

interface Fake {
  client: AnthropicMessagesClient;
  state: { params?: AnthropicCreateParams; options?: { signal?: AbortSignal } };
}

function fakeReturning(message: AnthropicMessage): Fake {
  const state: Fake['state'] = {};
  return {
    state,
    client: {
      messages: {
        create: (params, options) => {
          state.params = params;
          state.options = options;
          return Promise.resolve(message);
        },
      },
    },
  };
}

function fakeThrowing(error: unknown): AnthropicMessagesClient {
  return { messages: { create: () => Promise.reject(error) } };
}

const structuredRequest: CompletionRequest = {
  model: 'claude-x',
  system: 'sys',
  messages: [{ role: 'user', content: 'hi' }],
  maxOutputTokens: 100,
  outputSchema: { type: 'object' },
  temperature: 0.5,
  stopSequences: ['STOP'],
};

describe('AnthropicProvider.complete — structured output', () => {
  it('forces the structured tool and returns the tool input as structured', async () => {
    const message: AnthropicMessage = {
      id: 'm1',
      model: 'claude-x',
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 't', name: 'emit_structured_result', input: { name: 'N', summary: 'S' } }],
      usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 2 },
    };
    const fake = fakeReturning(message);
    const provider = new AnthropicProvider({ capabilities: CAPS, client: fake.client });
    const controller = new AbortController();
    const result = await provider.complete(structuredRequest, controller.signal);

    expect(result.structured).toEqual({ name: 'N', summary: 'S' });
    expect(result.stopReason).toBe('stop');
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 7, cachedInputTokens: 2 });
    expect(result.providerId).toBe('anthropic');

    expect(fake.state.params?.system).toBe('sys');
    expect(fake.state.params?.temperature).toBe(0.5);
    expect(fake.state.params?.stop_sequences).toEqual(['STOP']);
    expect(fake.state.params?.tools?.[0]?.name).toBe('emit_structured_result');
    expect(fake.state.params?.tools?.[0]?.input_schema).toEqual({ type: 'object' });
    expect(fake.state.params?.tool_choice).toEqual({ type: 'tool', name: 'emit_structured_result' });
    expect(fake.state.options?.signal).toBe(controller.signal);
  });

  it('leaves structured undefined when no tool call is present', async () => {
    const message: AnthropicMessage = {
      id: 'm2',
      model: 'claude-x',
      role: 'assistant',
      stop_reason: 'refusal',
      content: [],
      usage: { input_tokens: 1, output_tokens: 0 },
    };
    const provider = new AnthropicProvider({ capabilities: CAPS, client: fakeReturning(message).client });
    const result = await provider.complete(structuredRequest);
    expect(result.structured).toBeUndefined();
    expect(result.stopReason).toBe('refusal');
  });
});

describe('AnthropicProvider.complete — text output', () => {
  it('concatenates text blocks and maps end_turn to stop', async () => {
    const message: AnthropicMessage = {
      id: 'm3',
      model: 'claude-x',
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [
        { type: 'text', text: 'hello ' },
        { type: 'text', text: 'world' },
      ],
      usage: { input_tokens: 3, output_tokens: 2 },
    };
    const fake = fakeReturning(message);
    const provider = new AnthropicProvider({ capabilities: CAPS, client: fake.client });
    const result = await provider.complete({
      model: 'claude-x',
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 50,
    });
    expect(result.text).toBe('hello world');
    expect(result.stopReason).toBe('stop');
    expect(fake.state.params?.tools).toBeUndefined();
  });
});

describe('normalizeAnthropicError', () => {
  it('maps statuses and transport faults to the normalized error kinds', () => {
    expect(normalizeAnthropicError({ status: 429 }, 'anthropic', 'claude-x').kind).toBe('provider_transient');
    expect(normalizeAnthropicError({ status: 529 }, 'anthropic', 'claude-x').kind).toBe('provider_transient');
    expect(normalizeAnthropicError({ status: 503 }, 'anthropic', 'claude-x').kind).toBe('provider_transient');
    expect(normalizeAnthropicError({ status: 400 }, 'anthropic', 'claude-x').kind).toBe('provider_fatal');
    expect(normalizeAnthropicError({ status: 401 }, 'anthropic', 'claude-x').kind).toBe('provider_fatal');
    expect(normalizeAnthropicError({ name: 'AbortError' }, 'anthropic', 'claude-x').kind).toBe('cancelled');
    expect(normalizeAnthropicError({}, 'anthropic', 'claude-x').kind).toBe('provider_transient');
  });

  it('propagates through complete()', async () => {
    const provider = new AnthropicProvider({ capabilities: CAPS, client: fakeThrowing({ status: 429 }) });
    await expect(provider.complete(structuredRequest)).rejects.toMatchObject({ kind: 'provider_transient' });
  });
});
