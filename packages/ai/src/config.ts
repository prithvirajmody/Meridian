import type { BudgetLimits } from './budget.js';
import { AiError } from './errors.js';
import type { AiProvider } from './provider.js';
import type { RetryPolicy } from './retry.js';
import type { SessionMode } from './store.js';
import type { ModelId, ModelPricing, ProviderId, TaskClass } from './types.js';

export interface RouteTarget {
  readonly providerId: ProviderId;
  readonly model: ModelId;
}

/**
 * Provider and model routing is configuration, not code (§8.2). Completion task
 * classes route to a completion provider+model; `embedding` routes independently
 * so a completion-only provider is never asked to embed. Keys live on the
 * provider instances (constructed at the env/config edge), never in this object.
 */
export interface AiConfig {
  readonly mode: SessionMode;
  readonly routes: Partial<Readonly<Record<TaskClass, RouteTarget>>>;
  readonly budget?: BudgetLimits;
  readonly retry?: RetryPolicy;
  /**
   * Explicit consent to reach the network. Required for the two modes that can
   * egress to a real provider (`live`, `record`); `off` and `replay` never leave
   * the process and ignore it (ADR-0029 §trust boundary). The session refuses to
   * construct a network-capable mode without it — a call is never made silently.
   */
  readonly egressConsent?: boolean;
}

export function resolveRoute(config: AiConfig, taskClass: TaskClass): RouteTarget {
  const target = config.routes[taskClass];
  if (!target) {
    throw new AiError('config', `No route configured for task class '${taskClass}'.`);
  }
  return target;
}

export function pricingFor(provider: AiProvider, model: ModelId): ModelPricing {
  const pricing = provider.capabilities.models[model];
  if (!pricing) {
    throw new AiError('config', `Provider '${provider.id}' has no model '${model}' in its catalog.`, {
      providerId: provider.id,
      model,
    });
  }
  return pricing;
}

/**
 * Fail-fast validation at session construction: every configured route names a
 * registered provider that offers the required capability and lists the model.
 */
export function validateConfig(
  config: AiConfig,
  providers: ReadonlyMap<ProviderId, AiProvider>,
): void {
  for (const [taskClass, target] of Object.entries(config.routes) as [TaskClass, RouteTarget][]) {
    const provider = providers.get(target.providerId);
    if (!provider) {
      throw new AiError('config', `Route '${taskClass}' names unknown provider '${target.providerId}'.`, {
        providerId: target.providerId,
      });
    }
    if (taskClass === 'embedding') {
      if (!(provider.capabilities.embedding && provider.embed)) {
        throw new AiError(
          'unsupported',
          `Provider '${target.providerId}' does not support embeddings (route '${taskClass}').`,
          { providerId: target.providerId, model: target.model },
        );
      }
    } else if (!provider.capabilities.completion) {
      throw new AiError(
        'unsupported',
        `Provider '${target.providerId}' does not support completion (route '${taskClass}').`,
        { providerId: target.providerId, model: target.model },
      );
    }
    pricingFor(provider, target.model);
  }
}
