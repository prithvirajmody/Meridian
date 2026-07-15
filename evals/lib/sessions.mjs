/**
 * Session builders for the three eval paths (Phase 8F, ADR-0029/0030):
 *
 *   - `mock`   (default, no key): deterministic MockProviders, zero network.
 *              Proves plumbing + determinism; the offline gate.
 *   - `replay` (CI): load a committed recording snapshot and replay it with
 *              network disabled — a cache miss is a hard error (ADR-0030).
 *   - `record` (local/nightly, needs keys): drive the real vendor adapters,
 *              writing the response cache to a recording file for replay.
 *
 * Provider/model routing is pure configuration (ADR-0029): swapping the mock
 * for Anthropic/OpenAI is a config change here, never a change to a service.
 */
import {
  AiSession,
  MemoryResponseStore,
} from '../../packages/ai/dist/index.js';
import {
  mockSummarizeProvider,
  MOCK_COMPLETE_MODEL,
  MOCK_COMPLETE_PROVIDER_ID,
} from './mock-summarize.mjs';
import { mockEmbedProvider, MOCK_EMBED_MODEL, MOCK_EMBED_PROVIDER_ID } from './mock-embed.mjs';
import { mockExtractProvider, MOCK_EXTRACT_MODEL, MOCK_EXTRACT_PROVIDER_ID } from './mock-extract.mjs';

/** Offline summarize session: mock completion provider, no cache, no network. */
export function mockSummarizeSession() {
  const provider = mockSummarizeProvider();
  return new AiSession({
    config: {
      mode: 'off',
      routes: { summarization: { providerId: MOCK_COMPLETE_PROVIDER_ID, model: MOCK_COMPLETE_MODEL } },
    },
    providers: [provider],
  });
}

/** Offline cluster session: mock embedding provider, no cache, no network. */
export function mockClusterSession() {
  const provider = mockEmbedProvider();
  return new AiSession({
    config: {
      mode: 'off',
      routes: { embedding: { providerId: MOCK_EMBED_PROVIDER_ID, model: MOCK_EMBED_MODEL } },
    },
    providers: [provider],
  });
}

/** Offline argmap session: mock extraction provider, no cache, no network. */
export function mockArgmapSession() {
  const provider = mockExtractProvider();
  return new AiSession({
    config: {
      mode: 'off',
      routes: { extraction: { providerId: MOCK_EXTRACT_PROVIDER_ID, model: MOCK_EXTRACT_MODEL } },
    },
    providers: [provider],
  });
}

/**
 * Replay session from a committed recording `{ config, snapshot }`. Providers
 * are never called (a miss throws `replay_miss`); a dummy mock satisfies
 * validateConfig's capability check for the recorded route.
 */
export function replaySession(recording, provider) {
  return new AiSession({
    config: { ...recording.config, mode: 'replay' },
    providers: [provider],
    store: new MemoryResponseStore(recording.snapshot),
  });
}

/**
 * Live/record session. Constructs the real vendor adapter for `target.provider`
 * from env keys and records into a fresh MemoryResponseStore. Throws a clear
 * error (never a silent mock fallback) if the key or built package is missing —
 * a live eval must be unmistakably live. Returns `{ session, store, config }`.
 */
export async function recordSession(target) {
  if (target.egressConsent !== true) {
    throw new Error(
      'Explicit live-egress consent is required for --record (pass --consent-live).',
    );
  }
  const {
    AnthropicProvider,
    OpenAiProvider,
    createAnthropicClient,
    createOpenAiClient,
    ANTHROPIC_REFERENCE_CAPABILITIES,
    OPENAI_REFERENCE_CAPABILITIES,
  } = await import('../../packages/ai/dist/index.js');

  const store = new MemoryResponseStore();
  let provider;
  let routes;
  if (target.provider === 'anthropic') {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required for --record anthropic');
    provider = new AnthropicProvider({
      capabilities: ANTHROPIC_REFERENCE_CAPABILITIES,
      client: createAnthropicClient(),
    });
    routes =
      target.task === 'argmap'
        ? { extraction: { providerId: provider.id, model: target.model } }
        : { summarization: { providerId: provider.id, model: target.model } };
  } else if (target.provider === 'openai') {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required for --record openai');
    provider = new OpenAiProvider({
      capabilities: OPENAI_REFERENCE_CAPABILITIES,
      client: createOpenAiClient(),
    });
    routes = target.task === 'cluster' || target.task === 'embedding'
      ? { embedding: { providerId: provider.id, model: target.model } }
      : target.task === 'argmap'
        ? { extraction: { providerId: provider.id, model: target.model } }
        : { summarization: { providerId: provider.id, model: target.model } };
  } else {
    throw new Error(`unknown provider '${target.provider}' (expected anthropic|openai)`);
  }

  const config = {
    mode: 'record',
    routes,
    budget: target.budget,
    // AiSession enforces this independently of the CLI guard. Keeping both
    // gates means a direct recordSession caller still cannot egress silently.
    egressConsent: true,
  };
  const session = new AiSession({ config, providers: [provider], store });
  return { session, store, config, provider };
}
