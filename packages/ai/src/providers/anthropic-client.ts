import Anthropic from '@anthropic-ai/sdk';
import { AiError } from '../errors.js';
import type { AnthropicMessagesClient } from './anthropic.js';

/**
 * The ONLY module in the repository that imports `@anthropic-ai/sdk`. The
 * dependency-cruiser rule `sdk-imports-confined-to-ai-adapters` proves this
 * (§20). Everything above consumes the vendor-neutral `AnthropicMessagesClient`
 * interface; this factory is the single seam where the concrete SDK is built.
 *
 * The client is lazy in the sense that no network call happens at construction —
 * only when `messages.create` is invoked with a live key. Offline code and tests
 * never call this factory; they inject a fake client instead.
 */
export interface AnthropicClientOptions {
  /** API key. Falls back to the ANTHROPIC_API_KEY env var — the only key edge. */
  readonly apiKey?: string;
  readonly baseURL?: string;
  /** SDK-level retries; defaults to 0 so the gateway's own backoff is authoritative. */
  readonly maxRetries?: number;
}

export function createAnthropicClient(
  options: AnthropicClientOptions = {},
): AnthropicMessagesClient {
  const apiKey =
    options.apiKey ??
    (typeof process !== 'undefined' ? process.env['ANTHROPIC_API_KEY'] : undefined);
  if (!apiKey) {
    throw new AiError('config', 'ANTHROPIC_API_KEY is not set (keys come only from env/config).', {
      providerId: 'anthropic',
    });
  }
  const client = new Anthropic({
    apiKey,
    maxRetries: options.maxRetries ?? 0,
    ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
  });
  return client as unknown as AnthropicMessagesClient;
}
