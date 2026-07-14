import { AiError, isAiError } from './errors.js';

/** Bounded exponential backoff policy for normalized transient errors. */
export interface RetryPolicy {
  /** Total attempts including the first (>= 1). */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly factor: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 200,
  maxDelayMs: 8_000,
  factor: 2,
};

/** Injected clock — tests pass an immediate/counting sleeper so no real time passes. */
export type Sleeper = (ms: number, signal?: AbortSignal) => Promise<void>;

/** Deterministic delay for a zero-based attempt index (no jitter — reproducible). */
export function backoffDelay(policy: RetryPolicy, attemptIndex: number): number {
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * policy.factor ** attemptIndex);
}

/** Real wall-clock sleeper that honors an AbortSignal. */
export const realSleeper: Sleeper = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AiError('cancelled', 'Aborted before backoff delay.'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AiError('cancelled', 'Aborted during backoff delay.'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Run `fn`, retrying only on retryable `AiError`s (`provider_transient`) with
 * bounded exponential backoff. Non-retryable errors propagate immediately; an
 * aborted signal short-circuits before each attempt.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  sleep: Sleeper,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
    if (signal?.aborted) throw new AiError('cancelled', 'Aborted before provider attempt.');
    try {
      return await fn();
    } catch (error) {
      if (!(isAiError(error) && error.retryable)) throw error;
      lastError = error;
      if (attempt === policy.maxAttempts - 1) break;
      await sleep(backoffDelay(policy, attempt), signal);
    }
  }
  throw lastError;
}
