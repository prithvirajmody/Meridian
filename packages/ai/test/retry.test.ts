import { describe, expect, it } from 'vitest';
import { AiError } from '../src/errors.js';
import { backoffDelay, DEFAULT_RETRY_POLICY, withRetry, type RetryPolicy } from '../src/retry.js';
import { countingSleeper, fatalError, transientError } from './helpers.js';

describe('backoffDelay', () => {
  it('grows exponentially and caps at maxDelayMs', () => {
    const policy: RetryPolicy = { maxAttempts: 5, baseDelayMs: 200, maxDelayMs: 8_000, factor: 2 };
    expect(backoffDelay(policy, 0)).toBe(200);
    expect(backoffDelay(policy, 1)).toBe(400);
    expect(backoffDelay(policy, 2)).toBe(800);
    expect(backoffDelay(policy, 10)).toBe(8_000); // capped
  });
});

describe('withRetry', () => {
  it('retries transient errors then succeeds, with exponential backoff delays', async () => {
    const { sleeper, delays } = countingSleeper();
    let calls = 0;
    const result = await withRetry(
      () => {
        calls += 1;
        if (calls < 3) return Promise.reject(transientError());
        return Promise.resolve('ok');
      },
      DEFAULT_RETRY_POLICY,
      sleeper,
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(delays).toEqual([200, 400]);
  });

  it('does not retry non-retryable errors', async () => {
    const { sleeper, delays } = countingSleeper();
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls += 1;
          return Promise.reject(fatalError());
        },
        DEFAULT_RETRY_POLICY,
        sleeper,
      ),
    ).rejects.toMatchObject({ kind: 'provider_fatal' });
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it('gives up after maxAttempts and throws the last transient error', async () => {
    const { sleeper, delays } = countingSleeper();
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls += 1;
          return Promise.reject(transientError(429));
        },
        DEFAULT_RETRY_POLICY,
        sleeper,
      ),
    ).rejects.toBeInstanceOf(AiError);
    expect(calls).toBe(DEFAULT_RETRY_POLICY.maxAttempts);
    expect(delays).toHaveLength(DEFAULT_RETRY_POLICY.maxAttempts - 1);
  });

  it('short-circuits with a cancelled error when the signal is already aborted', async () => {
    const { sleeper } = countingSleeper();
    const controller = new AbortController();
    controller.abort();
    await expect(
      withRetry(() => Promise.resolve('never'), DEFAULT_RETRY_POLICY, sleeper, controller.signal),
    ).rejects.toMatchObject({ kind: 'cancelled' });
  });
});
