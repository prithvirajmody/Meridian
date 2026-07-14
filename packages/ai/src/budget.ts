import { AiError, type AiErrorContext } from './errors.js';
import type { ModelPricing, Usage } from './types.js';

/** Per-session ceilings (ADR-0032). An unset ceiling is unbounded. */
export interface BudgetLimits {
  /** Combined input+output token ceiling for the session. */
  readonly maxTokens?: number;
  /** Dollar ceiling for the session. */
  readonly maxDollars?: number;
  /**
   * Fraction of a configured ceiling (of tokens or dollars, whichever is
   * closer) at which {@link BudgetState.status} flips from `ok` to `warned`,
   * in (0, 1]. Defaults to {@link DEFAULT_WARN_THRESHOLD}.
   */
  readonly warnThreshold?: number;
}

/**
 * Coarse budget health (ADR-0032): `ok` well under every ceiling, `warned` once
 * spend crosses {@link BudgetLimits.warnThreshold} of the nearest ceiling, and
 * `stopped` once a ceiling is reached (the guard is/will be tripped).
 */
export type BudgetStatus = 'ok' | 'warned' | 'stopped';

/** Default fraction of a ceiling at which the guard reports `warned`. */
export const DEFAULT_WARN_THRESHOLD = 0.8;

export interface BudgetState {
  readonly spentTokens: number;
  readonly spentDollars: number;
  readonly calls: number;
  readonly tripped: boolean;
  /** Coarse health derived from spend, ceilings, and the warn threshold. */
  readonly status: BudgetStatus;
}

/** Dollar cost of a completed call, from provider-reported usage and pricing. */
export function costOf(usage: Usage, pricing: ModelPricing): number {
  return (
    (usage.inputTokens / 1_000_000) * pricing.inputPerMTok +
    (usage.outputTokens / 1_000_000) * pricing.outputPerMTok
  );
}

/**
 * Session budget guard (ADR-0032). Semantics are deliberately "post-hoc
 * ceiling": `precheck` rejects the *next* call once a ceiling has been reached,
 * so the call that tips spend over the line still returns a valid result and
 * every result already handed back to the caller stays valid — a mid-run trip
 * leaves valid partial state, never a rollback. Ordinary live-cache hits are
 * free. Replay hits intentionally call `precheck`/`commit` with their recorded
 * usage so offline accounting reproduces the original work.
 */
export class BudgetGuard {
  private spentTokens = 0;
  private spentDollars = 0;
  private calls = 0;
  private trippedFlag = false;
  private readonly warnThreshold: number;

  constructor(private readonly limits: BudgetLimits = {}) {
    this.warnThreshold = limits.warnThreshold ?? DEFAULT_WARN_THRESHOLD;
  }

  get state(): BudgetState {
    return {
      spentTokens: this.spentTokens,
      spentDollars: this.spentDollars,
      calls: this.calls,
      tripped: this.trippedFlag,
      status: this.status(),
    };
  }

  get isTripped(): boolean {
    return this.trippedFlag;
  }

  /** Pre-call gate. Throws `budget_exceeded` if a ceiling is already reached. */
  precheck(context: AiErrorContext = {}): void {
    if (this.exceeded()) {
      this.trippedFlag = true;
      throw new AiError(
        'budget_exceeded',
        `Session budget reached (tokens=${this.spentTokens}, dollars=${this.spentDollars.toFixed(6)}); prior results remain valid.`,
        context,
      );
    }
  }

  /** Records the cost of a completed provider call. */
  commit(usage: Usage, dollars: number): void {
    this.spentTokens += usage.inputTokens + usage.outputTokens;
    this.spentDollars += dollars;
    this.calls += 1;
  }

  private exceeded(): boolean {
    const overTokens =
      this.limits.maxTokens !== undefined && this.spentTokens >= this.limits.maxTokens;
    const overDollars =
      this.limits.maxDollars !== undefined && this.spentDollars >= this.limits.maxDollars;
    return overTokens || overDollars;
  }

  /** Whether any ceiling is configured (otherwise spend is unbounded). */
  private hasLimit(): boolean {
    return this.limits.maxTokens !== undefined || this.limits.maxDollars !== undefined;
  }

  /** Fraction of the nearest configured ceiling the session has consumed. */
  private utilization(): number {
    let frac = 0;
    if (this.limits.maxTokens !== undefined && this.limits.maxTokens > 0) {
      frac = Math.max(frac, this.spentTokens / this.limits.maxTokens);
    }
    if (this.limits.maxDollars !== undefined && this.limits.maxDollars > 0) {
      frac = Math.max(frac, this.spentDollars / this.limits.maxDollars);
    }
    return frac;
  }

  private status(): BudgetStatus {
    if (this.trippedFlag || this.exceeded()) return 'stopped';
    if (this.hasLimit() && this.utilization() >= this.warnThreshold) return 'warned';
    return 'ok';
  }
}
