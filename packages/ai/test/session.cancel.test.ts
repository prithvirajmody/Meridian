import { describe, expect, it } from 'vitest';
import { AiError } from '../src/errors.js';
import { MockProvider } from '../src/mock-provider.js';
import type { Sleeper } from '../src/retry.js';
import { AiSession } from '../src/session.js';
import {
  COMPLETION_CAPS,
  completionConfig,
  countingSleeper,
  summarySpec,
  transientError,
} from './helpers.js';

const input = { nodeId: 'n1', text: 'body' };
const VALID = { name: 'N', summary: 'S' };

describe('AiSession.call — cancellation', () => {
  it('rejects with cancelled before any provider call when the signal is pre-aborted', async () => {
    const provider = new MockProvider({
      id: 'mock',
      capabilities: COMPLETION_CAPS,
      onComplete: () => ({ kind: 'json', value: VALID }),
    });
    const session = new AiSession({
      config: completionConfig('off'),
      providers: [provider],
      sleeper: countingSleeper().sleeper,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      session.call(summarySpec, input, { signal: controller.signal }),
    ).rejects.toMatchObject({ kind: 'cancelled' });
    expect(provider.completionCount).toBe(0);
  });

  it('rejects with cancelled when the signal aborts during the provider call', async () => {
    const controller = new AbortController();
    const provider = new MockProvider({
      id: 'mock',
      capabilities: COMPLETION_CAPS,
      onComplete: () => {
        controller.abort();
        return { kind: 'json', value: VALID };
      },
    });
    const session = new AiSession({
      config: completionConfig('off'),
      providers: [provider],
      sleeper: countingSleeper().sleeper,
    });
    await expect(
      session.call(summarySpec, input, { signal: controller.signal }),
    ).rejects.toMatchObject({ kind: 'cancelled' });
  });

  it('rejects with cancelled when the signal aborts during backoff', async () => {
    const controller = new AbortController();
    const abortingSleeper: Sleeper = () => {
      controller.abort();
      return Promise.reject(new AiError('cancelled', 'aborted during backoff'));
    };
    const provider = new MockProvider({
      id: 'mock',
      capabilities: COMPLETION_CAPS,
      onComplete: () => ({ kind: 'error', error: transientError() }),
    });
    const session = new AiSession({
      config: completionConfig('off'),
      providers: [provider],
      sleeper: abortingSleeper,
    });
    await expect(
      session.call(summarySpec, input, { signal: controller.signal }),
    ).rejects.toMatchObject({ kind: 'cancelled' });
    expect(provider.completionCount).toBe(1);
  });
});
