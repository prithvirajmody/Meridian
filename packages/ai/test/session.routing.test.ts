import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AiConfig } from '../src/config.js';
import { MockProvider } from '../src/mock-provider.js';
import { definePromptSpec } from '../src/prompt-spec.js';
import { AiSession } from '../src/session.js';
import { EMBEDDING_PROMPT_VERSION, MemoryResponseStore } from '../src/store.js';
import { COMPLETION_CAPS, EMBED_CAPS, countingSleeper, summarySpec } from './helpers.js';

const extractSpec = definePromptSpec<{ text: string }, { items: string[] }>({
  id: 'extract',
  version: '1',
  taskClass: 'extraction',
  schema: z.object({ items: z.array(z.string()) }),
  maxOutputTokens: 128,
  render: (input) => ({ messages: [{ role: 'user', content: input.text }] }),
});

function completionProvider(id: string): MockProvider {
  return new MockProvider({
    id,
    capabilities: COMPLETION_CAPS,
    onComplete: (req) =>
      req.model === 'test-model' && id === 'extractor'
        ? { kind: 'json', value: { items: ['a'] } }
        : { kind: 'json', value: { name: 'N', summary: 'S' } },
  });
}

function embedProvider(): MockProvider {
  return new MockProvider({
    id: 'embedder',
    capabilities: EMBED_CAPS,
    onEmbed: (req) => req.input.map((_, i) => [i]),
  });
}

describe('routing by task class', () => {
  it('dispatches each task class to its configured provider and model', async () => {
    const summarizer = completionProvider('summarizer');
    const extractor = completionProvider('extractor');
    const config: AiConfig = {
      mode: 'off',
      routes: {
        summarization: { providerId: 'summarizer', model: 'test-model' },
        extraction: { providerId: 'extractor', model: 'test-model' },
      },
    };
    const session = new AiSession({
      config,
      providers: [summarizer, extractor],
      sleeper: countingSleeper().sleeper,
    });

    await session.call(summarySpec, { nodeId: 'n', text: 't' });
    await session.call(extractSpec, { text: 't' });

    expect(summarizer.completionCount).toBe(1);
    expect(extractor.completionCount).toBe(1);
  });
});

describe('validateConfig (fail-fast at construction)', () => {
  const base = (routes: AiConfig['routes']): AiConfig => ({ mode: 'off', routes });

  it('rejects an unknown provider', () => {
    expect(
      () =>
        new AiSession({
          config: base({ summarization: { providerId: 'nope', model: 'test-model' } }),
          providers: [completionProvider('summarizer')],
        }),
    ).toThrowError(/unknown provider/i);
  });

  it('rejects a model absent from the provider catalog', () => {
    expect(
      () =>
        new AiSession({
          config: base({ summarization: { providerId: 'summarizer', model: 'ghost' } }),
          providers: [completionProvider('summarizer')],
        }),
    ).toThrowError(/no model/i);
  });

  it('rejects an embedding route pointed at a non-embedding provider', () => {
    expect(
      () =>
        new AiSession({
          config: base({ embedding: { providerId: 'summarizer', model: 'test-model' } }),
          providers: [completionProvider('summarizer')],
        }),
    ).toThrowError(/does not support embeddings/i);
  });

  it('rejects a completion route pointed at an embedding-only provider', () => {
    expect(
      () =>
        new AiSession({
          config: base({ summarization: { providerId: 'embedder', model: 'embed-model' } }),
          providers: [embedProvider()],
        }),
    ).toThrowError(/does not support completion/i);
  });

  it.each(['live', 'record'] as const)(
    'requires explicit egress consent for %s mode at the gateway boundary',
    (mode) => {
      expect(
        () =>
          new AiSession({
            config: {
              mode,
              routes: { summarization: { providerId: 'summarizer', model: 'test-model' } },
            },
            providers: [completionProvider('summarizer')],
          }),
      ).toThrowError(/explicit egress consent/i);
    },
  );
});

describe('AiSession.embed — independent route', () => {
  const config = (mode: AiConfig['mode']): AiConfig => ({
    mode,
    routes: { embedding: { providerId: 'embedder', model: 'embed-model' } },
    ...((mode === 'live' || mode === 'record') ? { egressConsent: true } : {}),
  });

  it('embeds through the independent embedding route', async () => {
    const provider = embedProvider();
    const session = new AiSession({
      config: config('off'),
      providers: [provider],
      sleeper: countingSleeper().sleeper,
    });
    const result = await session.embed(['a', 'b']);
    expect(result.vectors).toEqual([[0], [1]]);
    expect(result.providerId).toBe('embedder');
    expect(result.model).toBe('embed-model');
  });

  it('caches embeddings in live mode and replays them without a provider call', async () => {
    const provider = embedProvider();
    const store = new MemoryResponseStore();
    const live = new AiSession({
      config: config('live'),
      providers: [provider],
      store,
      sleeper: countingSleeper().sleeper,
    });
    await live.embed(['a']);
    const cached = await live.embed(['a']);
    expect(cached.cached).toBe(true);
    expect(provider.embeddingCount).toBe(1);
    expect(Object.values(store.snapshot())[0]?.meta.promptVersion).toBe(EMBEDDING_PROMPT_VERSION);

    const replayProvider = embedProvider();
    const replay = new AiSession({
      config: config('replay'),
      providers: [replayProvider],
      store: new MemoryResponseStore(store.snapshot()),
      sleeper: countingSleeper().sleeper,
    });
    const replayed = await replay.embed(['a']);
    expect(replayed.cached).toBe(true);
    expect(replayProvider.embeddingCount).toBe(0);
    expect(replay.budget.calls).toBe(1);
    expect(replay.budget.spentTokens).toBe(1);

    await expect(replay.embed(['missing'])).rejects.toMatchObject({ kind: 'replay_miss' });
  });
});
