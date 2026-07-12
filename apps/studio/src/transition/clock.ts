/**
 * Injected time for the transition player (ADR-0023 "time is injected").
 * Studio injects `performance.now`; Playwright boots with `?clock=manual` and
 * drives a {@link ManualClock} through the test API, which is what makes
 * mid-transition screenshot baselines deterministic. Nothing in the animation
 * path may read wall time except through this seam.
 */

export interface StudioClock {
  now(): number;
  /** True for the deterministic test clock: the player must not self-schedule
   * frames — the test drives every tick. */
  readonly manual: boolean;
}

export function realClock(): StudioClock {
  return { now: () => performance.now(), manual: false };
}

export class ManualClock implements StudioClock {
  readonly manual = true;
  private t = 0;

  now(): number {
    return this.t;
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`ManualClock.advance(${ms})`);
    this.t += ms;
  }
}
