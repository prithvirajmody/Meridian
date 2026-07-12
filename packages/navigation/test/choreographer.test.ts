/**
 * TransitionChoreographer plans (ADR-0023) for hand-built cut diffs: enter
 * spawn geometry (nested in the parent's old rect), exit merge geometry
 * (collapsed into the ancestor's new rect), moves, sourceless/targetless,
 * empty and identical cuts (→ empty plan), and durations.
 */
import { describe, expect, it } from 'vitest';
import { asNodeId } from '@meridian/graph-core';
import { deriveRefinementMap } from '../src/refinement.js';
import { planTransition, TransitionChoreographer } from '../src/choreographer.js';
import { rectContains } from '../src/geometry.js';
import { BASE_TRANSITION_MS } from '../src/constants.js';
import { buildSpace, cutAt, cutOf, layoutOf, rect } from './helpers.js';

const id = (s: string) => asNodeId(s);
const space = buildSpace([{ id: 'P', children: [{ id: 'c1' }, { id: 'c2' }] }]);

describe('planTransition — geometry', () => {
  it('refinement: children spawn nested inside the parent old rect, fade in; parent exits expanding to the child bbox', () => {
    const from = { cut: cutAt(space, 0), layout: layoutOf({ P: rect(0, 0, 100, 100) }) };
    const to = {
      cut: cutAt(space, 1),
      layout: layoutOf({ c1: rect(0, 0, 40, 40), c2: rect(60, 60, 40, 40) }),
    };
    const ref = deriveRefinementMap(from.cut, to.cut, space);
    const plan = planTransition(from, to, ref);

    expect(plan.mode).toBe('choreographed');
    expect(plan.durationMs).toBe(BASE_TRANSITION_MS);
    expect(plan.move).toEqual([]);
    expect(plan.enter).toHaveLength(2);

    // Each entering child spawns from a sub-rect nested inside P's old rect.
    for (const anim of plan.enter) {
      expect(anim.fadeIn).toBe(true);
      const P = rect(0, 0, 100, 100);
      expect(rectContains(P, { x: anim.fromRect.x, y: anim.fromRect.y })).toBe(true);
      expect(anim.fromRect.x + anim.fromRect.width).toBeLessThanOrEqual(100 + 1e-9);
      expect(anim.fromRect.y + anim.fromRect.height).toBeLessThanOrEqual(100 + 1e-9);
    }
    // c1's final rect is the top-left child, so it spawns from the top-left of P.
    const c1 = plan.enter.find((a) => a.id === id('c1'))!;
    expect(c1.toRect).toEqual(rect(0, 0, 40, 40));
    expect(c1.fromRect.x).toBeCloseTo(0, 9);
    expect(c1.fromRect.y).toBeCloseTo(0, 9);

    // P exits, expanding to the bbox of {c1, c2} = (0,0,100,100).
    expect(plan.exit).toHaveLength(1);
    const p = plan.exit[0]!;
    expect(p.id).toBe(id('P'));
    expect(p.fadeOut).toBe(true);
    expect(p.fromRect).toEqual(rect(0, 0, 100, 100));
    expect(p.toRect).toEqual(rect(0, 0, 100, 100)); // bbox of children
  });

  it('coarsening: parent spawns from child bbox; children collapse into the parent new rect', () => {
    const from = {
      cut: cutAt(space, 1),
      layout: layoutOf({ c1: rect(0, 0, 40, 40), c2: rect(60, 60, 40, 40) }),
    };
    const to = { cut: cutAt(space, 0), layout: layoutOf({ P: rect(10, 10, 80, 80) }) };
    const ref = deriveRefinementMap(from.cut, to.cut, space);
    const plan = planTransition(from, to, ref);

    expect(plan.mode).toBe('choreographed');
    const p = plan.enter.find((a) => a.id === id('P'))!;
    expect(p.fadeIn).toBe(true);
    expect(p.fromRect).toEqual(rect(0, 0, 100, 100)); // bbox of c1,c2
    expect(p.toRect).toEqual(rect(10, 10, 80, 80));

    // c1 collapses into a sub-rect of P's new rect.
    const c1 = plan.exit.find((a) => a.id === id('c1'))!;
    expect(c1.fadeOut).toBe(true);
    expect(c1.fromRect).toEqual(rect(0, 0, 40, 40));
    const Pnew = rect(10, 10, 80, 80);
    expect(rectContains(Pnew, { x: c1.toRect.x, y: c1.toRect.y })).toBe(true);
  });

  it('identical cut + identical layout → empty plan (no enter/exit/move)', () => {
    const cut = cutAt(space, 1);
    const layout = layoutOf({ c1: rect(0, 0, 40, 40), c2: rect(60, 60, 40, 40) });
    const ref = deriveRefinementMap(cut, cut, space);
    const plan = planTransition({ cut, layout }, { cut, layout }, ref);
    expect(plan.mode).toBe('choreographed');
    expect(plan.enter).toEqual([]);
    expect(plan.exit).toEqual([]);
    expect(plan.move).toEqual([]);
  });

  it('empty cuts → empty choreographed plan', () => {
    const empty = { cut: cutOf([]), layout: layoutOf({}) };
    const ref = deriveRefinementMap(empty.cut, empty.cut, space);
    const plan = planTransition(empty, empty, ref);
    expect(plan.mode).toBe('choreographed');
    expect(plan.enter).toEqual([]);
    expect(plan.exit).toEqual([]);
    expect(plan.move).toEqual([]);
    expect(plan.durationMs).toBe(BASE_TRANSITION_MS);
  });

  it('displaced moves are emitted; held moves (≤ ε·Λ) are skipped', () => {
    const cut = cutOf(['c1', 'c2']);
    const from = {
      cut,
      layout: layoutOf({ c1: rect(0, 0, 10, 10), c2: rect(100, 0, 10, 10) }),
      hints: { spacing: 10 },
    };
    const to = {
      cut,
      // c1 held (moved 1 < ε·Λ = 5); c2 displaced (moved 20 > 5). c2's d̂ = 2
      // keeps stability (0.9375+0.5)/2 = 0.72 above the 0.5 degrade floor.
      layout: layoutOf({ c1: rect(1, 0, 10, 10), c2: rect(120, 0, 10, 10) }),
      hints: { spacing: 10 },
    };
    const ref = deriveRefinementMap(cut, cut, space);
    const plan = planTransition(from, to, ref);
    expect(plan.move.map((m) => m.id)).toEqual([id('c2')]);
  });

  it('sourceless enters fade in at their final rect', () => {
    // A single sourceless enter would trip the sourceless-majority degrade, so
    // pair it with two ancestor-sourced enters to keep the ratio below 50%.
    const from = { cut: cutOf(['P']), layout: layoutOf({ P: rect(0, 0, 100, 100) }) };
    const to = {
      cut: cutOf(['c1', 'c2', 'orphan']),
      layout: layoutOf({
        c1: rect(0, 0, 40, 40),
        c2: rect(60, 60, 40, 40),
        orphan: rect(200, 200, 20, 20),
      }),
    };
    const ref = deriveRefinementMap(from.cut, to.cut, space);
    const plan = planTransition(from, to, ref);
    expect(plan.mode).toBe('choreographed');
    const orphan = plan.enter.find((a) => a.id === id('orphan'))!;
    expect(orphan.fromRect).toEqual(orphan.toRect);
    expect(orphan.fadeIn).toBe(true);
  });

  it('the class method delegates to the pure function', () => {
    const from = { cut: cutAt(space, 0), layout: layoutOf({ P: rect(0, 0, 100, 100) }) };
    const to = {
      cut: cutAt(space, 1),
      layout: layoutOf({ c1: rect(0, 0, 40, 40), c2: rect(60, 60, 40, 40) }),
    };
    const ref = deriveRefinementMap(from.cut, to.cut, space);
    expect(new TransitionChoreographer().plan(from, to, ref)).toEqual(planTransition(from, to, ref));
  });
});
