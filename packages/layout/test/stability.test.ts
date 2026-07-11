/**
 * stabilityScore vs hand-computed values (ADR-0016; ROADMAP 4B test list).
 * Nodes are modelled as point-rects so a rect's center equals its `(x, y)`.
 * `Λ` (characteristic length) is read from `prev.edgeRoutes` keys, falling back
 * to `hints.spacing` then `1` — see the scorer's deviation note.
 */
import { describe, expect, it } from 'vitest';
import { stabilityScore, type LayoutHints, type LayoutResult, type Point, type Rect } from '../src/index.js';
import { n } from './helpers.js';

/** A result whose nodes are point-rects centered at the given coordinates. */
function resultAt(centers: Record<string, Point>, edgeKeys: string[] = []): LayoutResult {
  const positions = new Map<ReturnType<typeof n>, Rect>();
  for (const [id, c] of Object.entries(centers)) positions.set(n(id), { x: c.x, y: c.y, width: 0, height: 0 });
  const edgeRoutes = new Map<string, readonly Point[]>();
  for (const k of edgeKeys) edgeRoutes.set(k, []);
  return { positions, bounds: { x: 0, y: 0, width: 0, height: 0 }, stability: 0, edgeRoutes };
}

const NO_HINTS: LayoutHints = {};

describe('stabilityScore', () => {
  it('first-ever layout (no prev) is vacuously stable', () => {
    const cur = resultAt({ a: { x: 0, y: 0 }, b: { x: 10, y: 0 } });
    expect(stabilityScore(undefined, cur, NO_HINTS)).toEqual({ stability: 1, persisted: 0, added: 2, removed: 0 });
  });

  it('identical layout scores 1 with zero churn', () => {
    const prev = resultAt({ a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }, ['a→b→rel:x']);
    const cur = resultAt({ a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }, ['a→b→rel:x']);
    expect(stabilityScore(prev, cur, NO_HINTS)).toEqual({ stability: 1, persisted: 2, added: 0, removed: 0 });
  });

  it('Λ from prev edge, half-gap move: k(0.5)=0.875, mean over 2 = 0.9375', () => {
    // Λ = median neighbor-gap = dist(a,b) = 100. a moves 50 → d̂=0.5; b holds.
    const prev = resultAt({ a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }, ['a→b→rel:x']);
    const cur = resultAt({ a: { x: 50, y: 0 }, b: { x: 100, y: 0 } }, ['a→b→rel:x']);
    const s = stabilityScore(prev, cur, NO_HINTS);
    expect(s.stability).toBeCloseTo(0.9375, 10);
    expect(s).toMatchObject({ persisted: 2, added: 0, removed: 0 });
  });

  it('added and removed nodes are excluded from P but counted in diagnostics', () => {
    // No prev edges → Λ = hints.spacing = 10. a moves 5 → d̂=0.5 → k=0.875.
    const prev = resultAt({ a: { x: 0, y: 0 }, b: { x: 0, y: 0 } });
    const cur = resultAt({ a: { x: 5, y: 0 }, c: { x: 0, y: 0 } });
    const s = stabilityScore(prev, cur, { spacing: 10 });
    expect(s.stability).toBeCloseTo(0.875, 10);
    expect(s).toMatchObject({ persisted: 1, added: 1, removed: 1 });
  });

  it('a full-D teleport scores 0', () => {
    // Λ = spacing = 10; move 40 → d̂ = 4 = D → k = 0.
    const prev = resultAt({ a: { x: 0, y: 0 } });
    const cur = resultAt({ a: { x: 40, y: 0 } });
    expect(stabilityScore(prev, cur, { spacing: 10 }).stability).toBe(0);
  });

  it('Λ falls back to 1 when there are no edges and spacing is unset', () => {
    // Λ = 1; move 2 → d̂ = 2 → k = 1 − 0.5 = 0.5.
    const prev = resultAt({ a: { x: 0, y: 0 } });
    const cur = resultAt({ a: { x: 2, y: 0 } });
    expect(stabilityScore(prev, cur, NO_HINTS).stability).toBeCloseTo(0.5, 10);
  });

  it('is symmetric-free of routes: coincident prev neighbors fall back to spacing', () => {
    // Both prev centers coincide → median gap 0 → non-positive → fallback spacing 10.
    const prev = resultAt({ a: { x: 0, y: 0 }, b: { x: 0, y: 0 } }, ['a→b→rel:x']);
    const cur = resultAt({ a: { x: 5, y: 0 }, b: { x: 0, y: 0 } }, ['a→b→rel:x']);
    // a moves 5 with Λ=10 → k(0.5)=0.875; b holds → 1; mean = 0.9375.
    expect(stabilityScore(prev, cur, { spacing: 10 }).stability).toBeCloseTo(0.9375, 10);
  });
});
