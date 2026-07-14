/**
 * The gateway's single error currency. Every failure a service can observe is
 * one of these kinds — vendor SDK errors are normalized into `provider_*` by
 * the adapters and never escape the provider boundary (§20).
 */
export type AiErrorKind =
  | 'config' // missing key, unknown provider, bad routing
  | 'unsupported' // capability not offered (e.g. embeddings on a text-only provider)
  | 'budget_exceeded' // BudgetGuard hard stop (ADR-0032)
  | 'replay_miss' // replay mode, no cached response (ADR-0030) — a hard error
  | 'schema_invalid' // zod validation failed after the one repair attempt
  | 'refusal' // provider refused to answer
  | 'cancelled' // AbortSignal fired
  | 'provider_transient' // retryable transport error (429 / 503 / 529 / network)
  | 'provider_fatal'; // non-retryable provider error (400 / 401 / …)

export interface AiErrorContext {
  readonly providerId?: string;
  readonly model?: string;
  readonly promptId?: string;
  readonly promptVersion?: string;
  readonly inputHash?: string;
  /** Provider HTTP status, when the error originated from a transport. */
  readonly status?: number;
  /** Raw provider payload / SDK error, retained for diagnostics. */
  readonly raw?: unknown;
}

export class AiError extends Error {
  constructor(
    readonly kind: AiErrorKind,
    message: string,
    readonly context: AiErrorContext = {},
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AiError';
  }

  /** True for kinds the retry policy is allowed to back off and re-attempt. */
  get retryable(): boolean {
    return this.kind === 'provider_transient';
  }
}

export function isAiError(value: unknown): value is AiError {
  return value instanceof AiError;
}
