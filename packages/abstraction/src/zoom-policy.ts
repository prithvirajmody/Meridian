/**
 * Zoom policy & the scalar→level mapping with hysteresis (ADR-0012; ROADMAP
 * Phase 3 §5, §7). A `ZoomPolicy` is `{ thresholds, hysteresis, budget }`:
 *
 * - `thresholds` are the `L−1` interior band boundaries `p₁ … p_{L−1}`
 *   (ascending, in `(0,1)`); band `i` is `[pᵢ, pᵢ₊₁)` with `p₀ = 0`, `p_L = 1`.
 *   `thresholds[k]` is `p_{k+1}` — the boundary *above* band `k`.
 * - `hysteresis` is a width `h ≥ 0` that makes a boundary sticky, so hovering
 *   never flaps the level (§5.4).
 * - `budget` is the node ceiling (ADR-0014) plus the optional induced-edge
 *   fan-out cap (ADR-0013).
 *
 * `levelForZoom` is a pure function of `(policy, chain, z, prevLevel?)`. With
 * `prevLevel` absent it returns the hysteresis-free nominal band; with it
 * present it applies ADR-0012's offset triggers and multi-band snap.
 *
 * NB (ADR deviation, flagged for fold-back): ADR-0012's prose states the
 * up-trigger as `z ≥ p_{prevLevel} + h/2`, but with `band i = [pᵢ, pᵢ₊₁)` the
 * boundary crossed going `prev → prev+1` is `p_{prev+1} = thresholds[prev]`,
 * not `p_{prev}`. We implement the boundary-consistent version (the only one
 * under which "hovering at a boundary never flaps" holds); the ADR's
 * subscripts are an off-by-one slip.
 */
import type { LevelChain } from './level-chain.js';

/** The viewport node ceiling and edge fan-out cap (ADR-0014 / ADR-0013). */
export interface Budget {
  /** Max visible nodes before salience degradation kicks in (ADR-0014). */
  readonly maxNodes: number;
  /** Induced-edge fan-out cap `M` (ADR-0013); defaults to `FANOUT_CAP` when
   * absent. A presentation hint, never a correctness claim. */
  readonly fanOut?: number;
}

/** Scalar→cut policy (ROADMAP §7). All fields are frozen as *mechanism* in P3
 * and re-tuned against the live camera in P6 (Phase 3 §9c). */
export interface ZoomPolicy {
  /** `L−1` interior band boundaries, ascending, each in `(0,1)`. */
  readonly thresholds: readonly number[];
  /** Hysteresis width `h ≥ 0`. */
  readonly hysteresis: number;
  /** Node budget + fan-out cap. Absent ⇒ no budget degradation. */
  readonly budget?: Budget;
}

/** The resolved base level plus the hysteresis-free nominal it was derived
 * from (both recorded in the {@link import('./resolver.js').CutTrace}). */
export interface LevelResolution {
  /** The base level `b` actually used for the cut (a containment depth). */
  readonly level: number;
  /** The band `z` falls in, ignoring hysteresis (ADR-0012). */
  readonly nominal: number;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Deepest legal level index for a chain: `L−1`, or `0` for an empty chain. */
export function maxLevelOf(chain: LevelChain): number {
  return Math.max(0, chain.depth - 1);
}

/** Validate a policy's thresholds are ascending and interior. Pure; throws a
 * located `RangeError` on a malformed policy (a programming error, not data). */
export function assertValidPolicy(policy: ZoomPolicy): void {
  if (!(policy.hysteresis >= 0) || !Number.isFinite(policy.hysteresis)) {
    throw new RangeError(`ZoomPolicy: hysteresis must be a finite number ≥ 0, got ${policy.hysteresis}`);
  }
  let prev = 0;
  for (let i = 0; i < policy.thresholds.length; i++) {
    const t = policy.thresholds[i]!;
    if (!Number.isFinite(t) || t <= 0 || t >= 1) {
      throw new RangeError(`ZoomPolicy: threshold[${i}] must be in the open interval (0,1), got ${t}`);
    }
    if (t <= prev) {
      throw new RangeError(`ZoomPolicy: thresholds must be strictly ascending; threshold[${i}]=${t} ≤ ${prev}`);
    }
    prev = t;
  }
}

/** The hysteresis-free band containing `z`: the number of thresholds `≤ z`,
 * clamped to `[0, maxLevel]`. Thresholds are ascending, so this is monotone. */
export function nominalLevel(policy: ZoomPolicy, z: number, maxLevel: number): number {
  let n = 0;
  for (const t of policy.thresholds) {
    if (z >= t) n++;
    else break;
  }
  return clamp(n, 0, maxLevel);
}

/**
 * Map a zoom scalar to a base level (ADR-0012). `z` is clamped to `[0,1]`.
 * With `prevLevel` absent the result is the nominal band (fresh, deterministic,
 * hysteresis-free). With `prevLevel` present:
 * - a jump of more than one band (`|nominal − prevLevel| > 1`) **snaps** to
 *   nominal (a fast/teleport zoom is not sticky);
 * - otherwise the level moves `prev → prev+1` only once `z ≥ thresholds[prev] +
 *   h/2`, and `prev → prev−1` only once `z < thresholds[prev−1] − h/2`; else it
 *   stays `prev`. A boundary hover therefore never flaps (§5.4).
 *
 * Pure and deterministic (I6).
 */
export function levelForZoom(
  policy: ZoomPolicy,
  chain: LevelChain,
  z: number,
  prevLevel?: number,
): LevelResolution {
  if (!Number.isFinite(z)) {
    throw new RangeError(`levelForZoom: zoom must be a finite number, got ${z}`);
  }
  const maxLevel = maxLevelOf(chain);
  const zc = clamp(z, 0, 1);
  const nominal = nominalLevel(policy, zc, maxLevel);

  if (prevLevel === undefined) return { level: nominal, nominal };

  const prev = clamp(Math.round(prevLevel), 0, maxLevel);
  if (Math.abs(nominal - prev) > 1) return { level: nominal, nominal }; // snap

  const h = policy.hysteresis;
  const upBoundary = prev < maxLevel ? policy.thresholds[prev] : undefined; // p_{prev+1}
  const downBoundary = prev > 0 ? policy.thresholds[prev - 1] : undefined; // p_{prev}
  let level = prev;
  if (upBoundary !== undefined && zc >= upBoundary + h / 2) level = prev + 1;
  else if (downBoundary !== undefined && zc < downBoundary - h / 2) level = prev - 1;
  return { level: clamp(level, 0, maxLevel), nominal };
}
