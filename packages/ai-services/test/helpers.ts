/**
 * Offline test plumbing for @meridian/ai-services (§18.2, ADR-0030): every
 * suite drives the real gateway pipeline against an in-process `MockProvider`,
 * so no test touches the network. Helpers build an {@link AiSession} wired to a
 * scripted completion provider and a deterministic embedding provider.
 */
import {
  type AiConfig,
  AiSession,
  type BudgetLimits,
  type MockCompletionHandler,
  type MockEmbeddingHandler,
  MockProvider,
  type ProviderCapabilities,
} from '@meridian/ai';

export const COMPLETION_CAPS: ProviderCapabilities = {
  completion: true,
  embedding: false,
  models: { 'test-model': { inputPerMTok: 10, outputPerMTok: 30 } },
};

export const EMBED_CAPS: ProviderCapabilities = {
  completion: false,
  embedding: true,
  models: { 'embed-model': { inputPerMTok: 1, outputPerMTok: 0 } },
};

export interface SessionKit {
  readonly session: AiSession;
  readonly completion: MockProvider;
  readonly embed: MockProvider;
}

export interface SessionOptions {
  readonly onComplete?: MockCompletionHandler;
  readonly onEmbed?: MockEmbeddingHandler;
  readonly budget?: BudgetLimits;
  readonly mode?: AiConfig['mode'];
}

/**
 * A session routing every completion task class to a scripted `mock` provider
 * and `embedding` to a deterministic `embed` provider. `mode: 'off'` by default
 * so every call reaches the mock (no cache) — deterministic because the mock is.
 */
export function makeSession(options: SessionOptions = {}): SessionKit {
  const completion = new MockProvider({
    id: 'mock',
    capabilities: COMPLETION_CAPS,
    ...(options.onComplete !== undefined ? { onComplete: options.onComplete } : {}),
  });
  const embed = new MockProvider({
    id: 'embed',
    capabilities: EMBED_CAPS,
    onEmbed: options.onEmbed ?? defaultEmbed,
  });
  const config: AiConfig = {
    mode: options.mode ?? 'off',
    routes: {
      summarization: { providerId: 'mock', model: 'test-model' },
      extraction: { providerId: 'mock', model: 'test-model' },
      'bulk-label': { providerId: 'mock', model: 'test-model' },
      embedding: { providerId: 'embed', model: 'embed-model' },
    },
    ...((options.mode === 'live' || options.mode === 'record') ? { egressConsent: true } : {}),
    ...(options.budget !== undefined ? { budget: options.budget } : {}),
  };
  const session = new AiSession({ config, providers: [completion, embed] });
  return { session, completion, embed };
}

/**
 * Deterministic 3-d embedding: a stable pseudo-vector derived from the text's
 * characters. Same text → same vector (so replay/determinism holds), and texts
 * sharing a leading token land near each other so clustering is meaningful.
 */
export function defaultEmbed(request: { readonly input: readonly string[] }): readonly (readonly number[])[] {
  return request.input.map((t) => embedText(t));
}

export function embedText(t: string): readonly number[] {
  let a = 0;
  let b = 0;
  let c = 0;
  for (let i = 0; i < t.length; i++) {
    const code = t.charCodeAt(i);
    if (i % 3 === 0) a += code;
    else if (i % 3 === 1) b += code;
    else c += code;
  }
  return [a, b, c];
}
