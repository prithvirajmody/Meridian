import OpenAI from 'openai';
import { AiError } from '../errors.js';
import type { OpenAiClient } from './openai.js';

/**
 * The ONLY module in the repository that imports `openai`. Confinement is proven
 * by the dependency-cruiser rule `sdk-imports-confined-to-ai-adapters` (§20).
 * Everything above consumes the vendor-neutral `OpenAiClient` interface. No
 * network call happens at construction; offline code and tests inject a fake.
 */
export interface OpenAiClientOptions {
  /** API key. Falls back to the OPENAI_API_KEY env var — the only key edge. */
  readonly apiKey?: string;
  readonly baseURL?: string;
  /** SDK-level retries; defaults to 0 so the gateway's own backoff is authoritative. */
  readonly maxRetries?: number;
}

export function createOpenAiClient(options: OpenAiClientOptions = {}): OpenAiClient {
  const apiKey =
    options.apiKey ?? (typeof process !== 'undefined' ? process.env['OPENAI_API_KEY'] : undefined);
  if (!apiKey) {
    throw new AiError('config', 'OPENAI_API_KEY is not set (keys come only from env/config).', {
      providerId: 'openai',
    });
  }
  const client = new OpenAI({
    apiKey,
    maxRetries: options.maxRetries ?? 0,
    ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
  });
  return client as unknown as OpenAiClient;
}
