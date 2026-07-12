/**
 * The stability scorer (ADR-0016), relocated from `@meridian/layout` at
 * subphase 6B. It is a **pure function of `LayoutResult`** — the type the
 * presentation waist already owns — so its natural home is `view-model`, not
 * the provider-host `layout` package. Layout re-exports it unchanged
 * (behaviour byte-identical); `@meridian/navigation` now imports it here,
 * satisfying the §20 dependency law (navigation may not import `layout`).
 * ADR-0016's Future implications anticipated exactly this reuse: "the pure
 * `stabilityScore` is exactly the input P6's `TransitionChoreographer` needs …
 * `Λ` (characteristic neighbour-gap) is reusable as the transition's spatial
 * scale."
 *
 * Re-layout after a small change must not teleport the nodes that did not
 * change; this makes "don't teleport" a **pure, verifiable number**
 * `stability ∈ [0,1]`. CI recomputes it independently of any provider, so a
 * provider cannot self-report a lie (ADR-0016 "Purity").
 *
 * `Λ` (the scale displacement is measured against) is the **median
 * center-to-center distance over `prev`'s induced edges** (ADR-0016), read from
 * `prev.edgeRoutes` keys (`"src→dst→kind"`, ADR-0013/0015). When `prev` exposes
 * no such edges (straight-line providers with empty `edgeRoutes`, or a
 * first-ever layout), `Λ` falls back to `hints.spacing`, then to `1`.
 */
import type { NodeId } from '@meridian/graph-core';
import type { Point, Rect } from './coords.js';
import type { LayoutHints, LayoutResult } from './layout-types.js';

/** ADR-0016 ramp cutoff `D`: a node that moved a full `D` neighbor-gaps scores
 * `0`. */
export const STABILITY_RAMP = 4;

/** ADR-0016 per-node tolerance `ε` (dimensionless, half of `Λ`): a node whose
 * normalized displacement `d̂ ≤ ε` is "held" — it moved less than half a
 * typical neighbour-gap, which reads as "stayed put." Exported because the
 * transition choreographer's degrade rule counts a move as animated only when
 * it is displaced more than `ε·Λ` (ADR-0023). */
export const STABILITY_EPSILON = 0.5;

/** Diagnostics returned alongside the score (ADR-0016; informational, not
 * gated). */
export interface StabilityScore {
  /** Mean per-node stability over the persistent set `P`, in `[0,1]`; `1` when
   * `P = ∅` (vacuously stable — e.g. a first-ever layout). */
  readonly stability: number;
  /** `|P|` — nodes present in both layouts. */
  readonly persisted: number;
  /** Nodes in `current` but not `prev` (added by the delta). */
  readonly added: number;
  /** Nodes in `prev` but not `current` (removed by the delta). */
  readonly removed: number;
}

/** ADR-0016 graded ramp `k(x) = clamp(1 − x/D, 0, 1)`. */
function k(x: number): number {
  const v = 1 - x / STABILITY_RAMP;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Center of a `Rect` (ADR-0015: `(x + w/2, y + h/2)`). */
function centerOf(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** Euclidean distance between two rect centers (ADR-0016 `d̂` numerator). */
function centerDistance(a: Rect, b: Rect): number {
  const ca = centerOf(a);
  const cb = centerOf(b);
  return Math.hypot(ca.x - cb.x, ca.y - cb.y);
}

/** Parse an `edgeRoutes` key `"src→dst→kind"` into its `(src, dst)` members. */
function parseEdgeKey(key: string): { src: NodeId; dst: NodeId } | undefined {
  const first = key.indexOf('→');
  if (first < 0) return undefined;
  const second = key.indexOf('→', first + 1);
  if (second < 0) return undefined;
  return { src: key.slice(0, first) as NodeId, dst: key.slice(first + 1, second) as NodeId };
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  const mid = n >> 1;
  return n % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * The characteristic length `Λ` (ADR-0016): median center-to-center distance
 * over `prev`'s induced edges (read from `prev.edgeRoutes` keys), with
 * `hints.spacing` then `1` fallbacks. A non-positive or non-finite median (all
 * neighbors coincident) also falls back, so `Λ > 0` always. Exported for the
 * transition choreographer, which uses `Λ` as its spatial scale (ADR-0023).
 */
export function characteristicLength(prev: LayoutResult, hints: LayoutHints): number {
  const gaps: number[] = [];
  if (prev.edgeRoutes !== undefined) {
    for (const key of prev.edgeRoutes.keys()) {
      const pair = parseEdgeKey(key);
      if (pair === undefined) continue;
      const a = prev.positions.get(pair.src);
      const b = prev.positions.get(pair.dst);
      if (a === undefined || b === undefined) continue;
      const ca = centerOf(a);
      const cb = centerOf(b);
      gaps.push(Math.hypot(ca.x - cb.x, ca.y - cb.y));
    }
  }
  const fallback = hints.spacing !== undefined && hints.spacing > 0 ? hints.spacing : 1;
  if (gaps.length === 0) return fallback;
  const m = median(gaps);
  return Number.isFinite(m) && m > 0 ? m : fallback;
}

/**
 * Score how well `current` preserves `prev` (ADR-0016). Pure and
 * deterministic: `stability` is the mean of `k(d̂(n))` over the persistent set
 * `P = keys(prev.positions) ∩ keys(current.positions)`, `1` when `P = ∅`.
 * Added/removed nodes are excluded from `P` (an added node had no prior
 * position; a removed one drops out) — their structural effect enters only
 * through how far persistent nodes moved.
 */
export function stabilityScore(
  prev: LayoutResult | undefined,
  current: LayoutResult,
  hints: LayoutHints,
): StabilityScore {
  if (prev === undefined) {
    return { stability: 1, persisted: 0, added: current.positions.size, removed: 0 };
  }
  const lambda = characteristicLength(prev, hints);
  let sum = 0;
  let persisted = 0;
  let added = 0;
  for (const [id, curr] of current.positions) {
    const before = prev.positions.get(id);
    if (before === undefined) {
      added++;
      continue;
    }
    persisted++;
    const dHat = centerDistance(before, curr) / lambda;
    sum += k(dHat);
  }
  let removed = 0;
  for (const id of prev.positions.keys()) {
    if (!current.positions.has(id)) removed++;
  }
  const stability = persisted === 0 ? 1 : sum / persisted;
  return { stability, persisted, added, removed };
}
