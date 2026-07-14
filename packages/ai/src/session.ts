import { BudgetGuard, type BudgetState, costOf } from './budget.js';
import { type AiConfig, pricingFor, resolveRoute, validateConfig } from './config.js';
import { AiError, type AiErrorContext } from './errors.js';
import { canonicalInputHash } from './hash.js';
import type { AiProvider } from './provider.js';
import type { PromptSpec } from './prompt-spec.js';
import {
  DEFAULT_RETRY_POLICY,
  realSleeper,
  type RetryPolicy,
  type Sleeper,
  withRetry,
} from './retry.js';
import { zodToJsonSchema } from './schema.js';
import {
  deriveKeyHash,
  EMBEDDING_PROMPT_VERSION,
  MemoryResponseStore,
  type ResponseKey,
  type ResponseStore,
  type SessionMode,
} from './store.js';
import type {
  CompletionRequest,
  CompletionResult,
  EmbeddingResult,
  Message,
  ModelId,
  ProviderId,
  StopReason,
  Usage,
} from './types.js';

export interface AiSessionOptions {
  readonly config: AiConfig;
  readonly providers: readonly AiProvider[];
  /** Cache/replay store. Defaults to an empty in-memory store. */
  readonly store?: ResponseStore;
  /** Injected sleeper for backoff — tests pass an immediate one. */
  readonly sleeper?: Sleeper;
}

export interface AiCallResult<T> {
  readonly value: T;
  readonly text?: string;
  readonly stopReason: StopReason;
  readonly usage: Usage;
  readonly providerId: ProviderId;
  readonly model: ModelId;
  readonly promptId: string;
  readonly promptVersion: string;
  readonly inputHash: string;
  readonly cached: boolean;
  readonly repaired: boolean;
}

export interface AiEmbedResult {
  readonly vectors: readonly (readonly number[])[];
  readonly usage: Usage;
  readonly providerId: ProviderId;
  readonly model: ModelId;
  readonly inputHash: string;
  readonly cached: boolean;
}

function throwIfAborted(signal: AbortSignal | undefined, context: AiErrorContext): void {
  if (signal?.aborted) throw new AiError('cancelled', 'Operation aborted.', context);
}

/**
 * The gateway session. `call` runs the fixed pipeline (ARCHITECTURE §8.3):
 *
 *   cache/replay hit → budget precheck → provider (bounded backoff on transient)
 *   → zod validate → exactly one repair attempt → typed rejection.
 *
 * Ordinary live-cache hits are free (skip budget and provider). Replay hits
 * never call a provider, but are metered from their recorded usage so offline
 * cost reports remain reproducible. In replay mode a miss is a hard
 * `replay_miss` error. `embed` runs the same cache/replay/budget discipline but
 * routes independently and skips schema validation.
 */
export class AiSession {
  private readonly config: AiConfig;
  private readonly providers: ReadonlyMap<ProviderId, AiProvider>;
  private readonly store: ResponseStore;
  private readonly sleeper: Sleeper;
  private readonly retry: RetryPolicy;
  private readonly guard: BudgetGuard;

  constructor(options: AiSessionOptions) {
    this.config = options.config;
    const map = new Map<ProviderId, AiProvider>();
    for (const provider of options.providers) map.set(provider.id, provider);
    this.providers = map;
    validateConfig(this.config, map);
    // Egress gate (ADR-0029): the network-capable modes refuse to construct
    // without explicit consent, so a real provider is never reached silently.
    if (
      (this.config.mode === 'live' || this.config.mode === 'record') &&
      !this.config.egressConsent
    ) {
      throw new AiError(
        'config',
        `Mode '${this.config.mode}' can reach a provider over the network and requires explicit egress consent (set config.egressConsent).`,
      );
    }
    this.store = options.store ?? new MemoryResponseStore();
    this.sleeper = options.sleeper ?? realSleeper;
    this.retry = this.config.retry ?? DEFAULT_RETRY_POLICY;
    this.guard = new BudgetGuard(this.config.budget);
  }

  get mode(): SessionMode {
    return this.config.mode;
  }

  get budget(): BudgetState {
    return this.guard.state;
  }

  async call<TInput, TOutput>(
    spec: PromptSpec<TInput, TOutput>,
    input: TInput,
    opts?: { readonly signal?: AbortSignal },
  ): Promise<AiCallResult<TOutput>> {
    const signal = opts?.signal;
    const route = resolveRoute(this.config, spec.taskClass);
    const provider = this.mustProvider(route.providerId);
    const pricing = pricingFor(provider, route.model);

    const rendered = spec.render(input);
    const outputSchema = zodToJsonSchema(spec.schema);
    const request: CompletionRequest = {
      model: route.model,
      messages: rendered.messages,
      maxOutputTokens: spec.maxOutputTokens,
      outputSchema,
      ...(rendered.system !== undefined ? { system: rendered.system } : {}),
      ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}),
      ...(spec.stopSequences !== undefined ? { stopSequences: spec.stopSequences } : {}),
    };

    const inputHash = canonicalInputHash({
      system: rendered.system ?? null,
      messages: rendered.messages,
      model: route.model,
      outputSchema,
      maxOutputTokens: spec.maxOutputTokens,
      temperature: spec.temperature ?? null,
      stopSequences: spec.stopSequences ?? null,
    });
    const errCtx: AiErrorContext = {
      providerId: provider.id,
      model: route.model,
      promptId: spec.id,
      promptVersion: spec.version,
      inputHash,
    };
    throwIfAborted(signal, errCtx);

    const keyBase = {
      kind: 'completion',
      providerId: provider.id,
      model: route.model,
      promptId: spec.id,
      promptVersion: spec.version,
      inputHash,
    } as const;

    // 1. Primary: cache/replay, else provider.
    const primary = await this.obtain(
      { ...keyBase, attempt: 'primary' },
      request,
      provider,
      pricing,
      errCtx,
      signal,
    );
    this.rejectRefusal(primary.result, errCtx);
    const firstParse = spec.schema.safeParse(primary.result.structured);
    if (firstParse.success) {
      return this.toResult(spec, primary.result, route.model, firstParse.data, inputHash, primary.cached, false);
    }

    // 2. Exactly one repair attempt.
    const repairRequest = buildRepairRequest(request, primary.result, firstParse.error.message);
    const repair = await this.obtain(
      { ...keyBase, attempt: 'repair' },
      repairRequest,
      provider,
      pricing,
      errCtx,
      signal,
    );
    this.rejectRefusal(repair.result, errCtx);
    const secondParse = spec.schema.safeParse(repair.result.structured);
    if (secondParse.success) {
      return this.toResult(spec, repair.result, route.model, secondParse.data, inputHash, false, true);
    }

    // 3. Typed rejection — raw response retained for diagnostics.
    throw new AiError(
      'schema_invalid',
      `Structured output failed schema validation after one repair attempt: ${secondParse.error.message}`,
      { ...errCtx, raw: repair.result.raw },
    );
  }

  async embed(
    input: readonly string[],
    opts?: { readonly signal?: AbortSignal },
  ): Promise<AiEmbedResult> {
    const signal = opts?.signal;
    const route = resolveRoute(this.config, 'embedding');
    const provider = this.mustProvider(route.providerId);
    const embedFn = provider.embed;
    if (!(provider.capabilities.embedding && embedFn)) {
      throw new AiError('unsupported', `Provider '${provider.id}' does not embed.`, {
        providerId: provider.id,
        model: route.model,
      });
    }
    const pricing = pricingFor(provider, route.model);
    const inputHash = canonicalInputHash({ model: route.model, input });
    const errCtx: AiErrorContext = { providerId: provider.id, model: route.model, inputHash };
    throwIfAborted(signal, errCtx);

    const key: ResponseKey = {
      kind: 'embedding',
      providerId: provider.id,
      model: route.model,
      promptId: 'embedding',
      promptVersion: EMBEDDING_PROMPT_VERSION,
      inputHash,
      attempt: 'primary',
    };
    const keyHash = deriveKeyHash(key);

    if (this.mode === 'live' || this.mode === 'replay') {
      const hit = await this.store.get(keyHash);
      if (hit) {
        const recorded = hit.value as EmbeddingResult;
        if (this.mode === 'replay') this.meterReplay(recorded.usage, pricing, errCtx);
        return this.toEmbedResult(recorded, route.model, inputHash, true);
      }
      if (this.mode === 'replay') {
        throw new AiError('replay_miss', `No recorded embedding for ${keyHash}.`, errCtx);
      }
    }

    this.guard.precheck(errCtx);
    const result = await withRetry(
      () => embedFn.call(provider, { model: route.model, input }, signal),
      this.retry,
      this.sleeper,
      signal,
    );
    this.guard.commit(result.usage, costOf(result.usage, pricing));
    if (this.mode === 'live' || this.mode === 'record') {
      await this.store.set(keyHash, { meta: key, value: result });
    }
    return this.toEmbedResult(result, route.model, inputHash, false);
  }

  /** Resolve a completion attempt from cache/replay or the provider, per mode. */
  private async obtain(
    key: ResponseKey,
    request: CompletionRequest,
    provider: AiProvider,
    pricing: Parameters<typeof costOf>[1],
    errCtx: AiErrorContext,
    signal: AbortSignal | undefined,
  ): Promise<{ result: CompletionResult; cached: boolean }> {
    const keyHash = deriveKeyHash(key);
    // `live` and `replay` read the cache; `record` always calls (to refresh the
    // fixture); `off` neither reads nor writes.
    if (this.mode === 'live' || this.mode === 'replay') {
      const hit = await this.store.get(keyHash);
      if (hit) {
        const recorded = hit.value as CompletionResult;
        if (this.mode === 'replay') this.meterReplay(recorded.usage, pricing, errCtx);
        return { result: recorded, cached: true };
      }
      if (this.mode === 'replay') {
        throw new AiError(
          'replay_miss',
          `No recorded response for the ${key.attempt} call (${keyHash}).`,
          errCtx,
        );
      }
    }
    this.guard.precheck(errCtx);
    const result = await withRetry(
      () => provider.complete(request, signal),
      this.retry,
      this.sleeper,
      signal,
    );
    this.guard.commit(result.usage, costOf(result.usage, pricing));
    if (this.mode === 'live' || this.mode === 'record') {
      await this.store.set(keyHash, { meta: key, value: result });
    }
    return { result, cached: false };
  }

  /** Meter a zero-network replay exactly as the recorded call was metered. */
  private meterReplay(
    usage: Usage,
    pricing: Parameters<typeof costOf>[1],
    errCtx: AiErrorContext,
  ): void {
    this.guard.precheck(errCtx);
    this.guard.commit(usage, costOf(usage, pricing));
  }

  private rejectRefusal(result: CompletionResult, errCtx: AiErrorContext): void {
    if (result.stopReason === 'refusal') {
      throw new AiError('refusal', 'Provider refused the request.', { ...errCtx, raw: result.raw });
    }
  }

  private mustProvider(id: ProviderId): AiProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new AiError('config', `Unknown provider '${id}'.`, { providerId: id });
    return provider;
  }

  private toResult<T>(
    spec: { readonly id: string; readonly version: string },
    completion: CompletionResult,
    routedModel: ModelId,
    value: T,
    inputHash: string,
    cached: boolean,
    repaired: boolean,
  ): AiCallResult<T> {
    return {
      value,
      ...(completion.text !== undefined ? { text: completion.text } : {}),
      stopReason: completion.stopReason,
      usage: completion.usage,
      providerId: completion.providerId,
      // Provenance must name the replay-key model selected by routing. Some
      // providers return a resolved/snapshotted model id in their response.
      model: routedModel,
      promptId: spec.id,
      promptVersion: spec.version,
      inputHash,
      cached,
      repaired,
    };
  }

  private toEmbedResult(
    result: EmbeddingResult,
    routedModel: ModelId,
    inputHash: string,
    cached: boolean,
  ): AiEmbedResult {
    return {
      vectors: result.vectors,
      usage: result.usage,
      providerId: result.providerId,
      model: routedModel,
      inputHash,
      cached,
    };
  }
}

function buildRepairRequest(
  request: CompletionRequest,
  previous: CompletionResult,
  errorMessage: string,
): CompletionRequest {
  const previousOutput = JSON.stringify(previous.structured ?? previous.text ?? null);
  const repairMessage: Message = {
    role: 'user',
    content:
      'Your previous response did not conform to the required schema.\n' +
      `Validation errors:\n${errorMessage}\n` +
      `Your previous output was:\n${previousOutput}\n` +
      'Return a corrected response that satisfies the schema exactly.',
  };
  return { ...request, messages: [...request.messages, repairMessage] };
}

export function createAiSession(options: AiSessionOptions): AiSession {
  return new AiSession(options);
}
