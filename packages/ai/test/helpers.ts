import { z } from 'zod';
import type { AiConfig } from '../src/config.js';
import { AiError } from '../src/errors.js';
import { definePromptSpec } from '../src/prompt-spec.js';
import type { Sleeper } from '../src/retry.js';
import type { ProviderCapabilities } from '../src/types.js';

export const summarySchema = z.object({ name: z.string(), summary: z.string() });
export type Summary = z.infer<typeof summarySchema>;

export interface SummaryInput {
  readonly nodeId: string;
  readonly text: string;
}

export const summarySpec = definePromptSpec<SummaryInput, Summary>({
  id: 'node-summary',
  version: '1',
  taskClass: 'summarization',
  schema: summarySchema,
  maxOutputTokens: 256,
  render: (input) => ({
    system: 'You summarize graph nodes.',
    messages: [{ role: 'user', content: `Summarize ${input.nodeId}:\n${input.text}` }],
  }),
});

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

/** Config routing every completion task class to the mock provider. */
export function completionConfig(mode: AiConfig['mode'], extra?: Partial<AiConfig>): AiConfig {
  return {
    mode,
    routes: {
      summarization: { providerId: 'mock', model: 'test-model' },
      extraction: { providerId: 'mock', model: 'test-model' },
      'bulk-label': { providerId: 'mock', model: 'test-model' },
    },
    ...((mode === 'live' || mode === 'record') ? { egressConsent: true } : {}),
    ...extra,
  };
}

/** Sleeper that never waits but records the delays it was asked for. */
export function countingSleeper(): { sleeper: Sleeper; delays: number[] } {
  const delays: number[] = [];
  const sleeper: Sleeper = (ms, signal) => {
    if (signal?.aborted) return Promise.reject(new AiError('cancelled', 'aborted in sleeper'));
    delays.push(ms);
    return Promise.resolve();
  };
  return { sleeper, delays };
}

export function transientError(status = 503): AiError {
  return new AiError('provider_transient', `transient ${status}`, { status });
}

export function fatalError(status = 400): AiError {
  return new AiError('provider_fatal', `fatal ${status}`, { status });
}
