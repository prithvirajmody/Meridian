import { describe, expect, it } from 'vitest';
import { BudgetGuard, costOf, DEFAULT_WARN_THRESHOLD } from '../src/budget.js';
import { AiError } from '../src/errors.js';
import type { Usage } from '../src/types.js';

const usage: Usage = { inputTokens: 10, outputTokens: 10 };

describe('costOf', () => {
  it('computes dollars from usage and pricing', () => {
    expect(costOf({ inputTokens: 1_000_000, outputTokens: 0 }, { inputPerMTok: 3, outputPerMTok: 9 })).toBeCloseTo(3);
    expect(costOf({ inputTokens: 0, outputTokens: 1_000_000 }, { inputPerMTok: 3, outputPerMTok: 9 })).toBeCloseTo(9);
  });
});

describe('BudgetGuard', () => {
  it('exposes the default 80% ok → warned → stopped state machine', () => {
    expect(DEFAULT_WARN_THRESHOLD).toBe(0.8);
    const guard = new BudgetGuard({ maxTokens: 100 });
    expect(guard.state.status).toBe('ok');

    guard.commit({ inputTokens: 79, outputTokens: 0 }, 0);
    expect(guard.state.status).toBe('ok');
    guard.commit({ inputTokens: 1, outputTokens: 0 }, 0);
    expect(guard.state.status).toBe('warned');
    guard.commit({ inputTokens: 20, outputTokens: 0 }, 0);
    expect(guard.state.status).toBe('stopped');
  });

  it('uses the most-consumed ceiling and accepts a configurable warn threshold', () => {
    const guard = new BudgetGuard({
      maxTokens: 1_000,
      maxDollars: 1,
      warnThreshold: 0.5,
    });
    guard.commit({ inputTokens: 10, outputTokens: 10 }, 0.5);
    expect(guard.state.status).toBe('warned');
  });

  it('allows calls under the token ceiling and accumulates spend', () => {
    const guard = new BudgetGuard({ maxTokens: 100 });
    guard.precheck();
    guard.commit(usage, 0.001);
    expect(guard.state.spentTokens).toBe(20);
    expect(guard.state.calls).toBe(1);
    expect(guard.isTripped).toBe(false);
    guard.precheck(); // still under 100
  });

  it('trips the NEXT call once the token ceiling is reached, preserving prior spend', () => {
    const guard = new BudgetGuard({ maxTokens: 20 });
    guard.precheck();
    guard.commit(usage, 0.001); // spent 20 == ceiling
    expect(() => guard.precheck()).toThrowError(AiError);
    expect(guard.isTripped).toBe(true);
    expect(guard.state.spentTokens).toBe(20); // prior state intact
    expect(guard.state.calls).toBe(1);
  });

  it('enforces the dollar ceiling independently', () => {
    const guard = new BudgetGuard({ maxDollars: 0.01 });
    guard.precheck();
    guard.commit(usage, 0.01);
    let thrown: unknown;
    try {
      guard.precheck();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AiError);
    expect((thrown as AiError).kind).toBe('budget_exceeded');
  });

  it('is unbounded when no limits are set', () => {
    const guard = new BudgetGuard();
    for (let i = 0; i < 100; i++) {
      guard.precheck();
      guard.commit(usage, 1);
    }
    expect(guard.isTripped).toBe(false);
    expect(guard.state.calls).toBe(100);
  });
});
