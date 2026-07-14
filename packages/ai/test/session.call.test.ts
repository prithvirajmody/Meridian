import { describe, expect, it } from 'vitest';
import { MockProvider } from '../src/mock-provider.js';
import type { AiProvider } from '../src/provider.js';
import { AiSession } from '../src/session.js';
import { MemoryResponseStore } from '../src/store.js';
import { COMPLETION_CAPS, completionConfig, countingSleeper, summarySpec } from './helpers.js';

function jsonProvider(value: unknown = { name: 'N', summary: 'S' }): MockProvider {
  return new MockProvider({
    id: 'mock',
    capabilities: COMPLETION_CAPS,
    onComplete: () => ({ kind: 'json', value }),
  });
}

const input = { nodeId: 'n1', text: 'body text' };

describe('AiSession.call — happy path', () => {
  it('renders, validates, and returns the typed structured value with response keys', async () => {
    const provider = jsonProvider();
    const session = new AiSession({
      config: completionConfig('off'),
      providers: [provider],
      sleeper: countingSleeper().sleeper,
    });
    const result = await session.call(summarySpec, input);

    expect(result.value).toEqual({ name: 'N', summary: 'S' });
    expect(result.providerId).toBe('mock');
    expect(result.model).toBe('test-model');
    expect(result.promptId).toBe('node-summary');
    expect(result.promptVersion).toBe('1');
    expect(result.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.cached).toBe(false);
    expect(result.repaired).toBe(false);

    const sent = provider.completionRequests[0];
    expect(sent?.outputSchema).toBeDefined();
    expect(sent?.system).toBe('You summarize graph nodes.');
    expect(sent?.messages[0]?.content).toContain('n1');
    expect(sent?.model).toBe('test-model');
  });

  it('uses the routed replay-key model in completion provenance', async () => {
    const provider: AiProvider = {
      id: 'mock',
      capabilities: COMPLETION_CAPS,
      complete: () => Promise.resolve({
        providerId: 'mock',
        // Providers may resolve an alias to a dated model in their response.
        model: 'test-model-2026-07-13',
        stopReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
        structured: { name: 'N', summary: 'S' },
        raw: {},
      }),
    };
    const session = new AiSession({
      config: completionConfig('off'),
      providers: [provider],
      sleeper: countingSleeper().sleeper,
    });

    const result = await session.call(summarySpec, input);
    expect(result.model).toBe('test-model');
  });
});

describe('AiSession.call — caching by mode', () => {
  it('live mode serves the second identical call from cache (provider called once)', async () => {
    const provider = jsonProvider();
    const session = new AiSession({
      config: completionConfig('live'),
      providers: [provider],
      store: new MemoryResponseStore(),
      sleeper: countingSleeper().sleeper,
    });
    const first = await session.call(summarySpec, input);
    const second = await session.call(summarySpec, input);
    expect(provider.completionCount).toBe(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.value).toEqual(first.value);
  });

  it('live mode calls again for a different input', async () => {
    const provider = jsonProvider();
    const session = new AiSession({
      config: completionConfig('live'),
      providers: [provider],
      store: new MemoryResponseStore(),
      sleeper: countingSleeper().sleeper,
    });
    await session.call(summarySpec, { nodeId: 'a', text: 'x' });
    await session.call(summarySpec, { nodeId: 'b', text: 'y' });
    expect(provider.completionCount).toBe(2);
  });

  it('off mode never touches the store — every call hits the provider', async () => {
    const provider = jsonProvider();
    const store = new MemoryResponseStore();
    const session = new AiSession({
      config: completionConfig('off'),
      providers: [provider],
      store,
      sleeper: countingSleeper().sleeper,
    });
    await session.call(summarySpec, input);
    await session.call(summarySpec, input);
    expect(provider.completionCount).toBe(2);
    expect(store.size).toBe(0);
  });

  it('record mode always calls the provider and (over)writes one cache entry', async () => {
    const provider = jsonProvider();
    const store = new MemoryResponseStore();
    const session = new AiSession({
      config: completionConfig('record'),
      providers: [provider],
      store,
      sleeper: countingSleeper().sleeper,
    });
    await session.call(summarySpec, input);
    await session.call(summarySpec, input);
    expect(provider.completionCount).toBe(2);
    expect(store.size).toBe(1);
  });
});
