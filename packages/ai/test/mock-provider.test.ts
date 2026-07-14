import { describe, expect, it } from 'vitest';
import { AiError } from '../src/errors.js';
import { MockProvider } from '../src/mock-provider.js';
import type { CompletionRequest, EmbeddingRequest } from '../src/types.js';

const request: CompletionRequest = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'hi' }],
  maxOutputTokens: 64,
};

describe('MockProvider.complete', () => {
  it('returns text outcomes and records the request', async () => {
    const provider = new MockProvider({ onComplete: () => ({ kind: 'text', text: 'hello' }) });
    const result = await provider.complete(request);
    expect(result.text).toBe('hello');
    expect(result.stopReason).toBe('stop');
    expect(provider.completionCount).toBe(1);
    expect(provider.completionRequests[0]).toBe(request);
  });

  it('returns structured json outcomes as successful completions', async () => {
    const provider = new MockProvider({ onComplete: () => ({ kind: 'json', value: { a: 1 } }) });
    const result = await provider.complete(request);
    expect(result.structured).toEqual({ a: 1 });
    expect(result.stopReason).toBe('stop');
  });

  it('surfaces refusals and thrown errors', async () => {
    const refuser = new MockProvider({ onComplete: () => ({ kind: 'refusal' }) });
    expect((await refuser.complete(request)).stopReason).toBe('refusal');

    const boom = new MockProvider({
      onComplete: () => ({ kind: 'error', error: new AiError('provider_fatal', 'boom') }),
    });
    await expect(boom.complete(request)).rejects.toMatchObject({ kind: 'provider_fatal' });
  });

  it('honors an already-aborted signal', async () => {
    const provider = new MockProvider();
    const controller = new AbortController();
    controller.abort();
    await expect(provider.complete(request, controller.signal)).rejects.toMatchObject({
      kind: 'cancelled',
    });
  });

  it('fromOutcomes yields successive outcomes then repeats the last', async () => {
    const provider = MockProvider.fromOutcomes([
      { kind: 'text', text: 'one' },
      { kind: 'text', text: 'two' },
    ]);
    expect((await provider.complete(request)).text).toBe('one');
    expect((await provider.complete(request)).text).toBe('two');
    expect((await provider.complete(request)).text).toBe('two');
  });
});

describe('MockProvider.embed', () => {
  const embedRequest: EmbeddingRequest = { model: 'embed-model', input: ['a', 'b'] };

  it('returns vectors from the embed handler', async () => {
    const provider = new MockProvider({
      capabilities: { completion: false, embedding: true, models: { 'embed-model': { inputPerMTok: 1, outputPerMTok: 0 } } },
      onEmbed: (req) => req.input.map((_, i) => [i, i + 1]),
    });
    const result = await provider.embed(embedRequest);
    expect(result.vectors).toEqual([
      [0, 1],
      [1, 2],
    ]);
    expect(provider.embeddingCount).toBe(1);
  });

  it('throws unsupported when there is no embed handler', async () => {
    const provider = new MockProvider();
    await expect(provider.embed(embedRequest)).rejects.toMatchObject({ kind: 'unsupported' });
  });
});
