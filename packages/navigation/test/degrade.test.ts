/**
 * The plan-time degrade-to-crossfade rule (ADR-0023). Each of the three
 * triggers is exercised in isolation and the diagnostics must name it. Plans
 * are built from hand-made RefinementMaps + layouts (the planners read only
 * refinement + layouts), so triggers can be isolated cleanly.
 */
import { describe, expect, it } from 'vitest';
import { asNodeId } from '@meridian/graph-core';
import type { LayoutResult, NodeId, Rect } from '@meridian/view-model';
import { planTransition } from '../src/choreographer.js';
import type { RefinementMap } from '../src/refinement.js';
import {
  CROSSFADE_MS,
  MAX_ANIMATED_NODES,
} from '../src/constants.js';

function layout(positions: ReadonlyMap<NodeId, Rect>): LayoutResult {
  return { positions, bounds: { x: 0, y: 0, width: 0, height: 0 }, stability: 1 };
}

const degradeDiag = (plan: ReturnType<typeof planTransition>) =>
  plan.diagnostics.find((d) => d.code === 'degrade-to-crossfade');

describe('degrade-to-crossfade — trigger 1: animated-node budget', () => {
  it(`> ${MAX_ANIMATED_NODES} animated nodes degrades and names the trigger`, () => {
    const n = MAX_ANIMATED_NODES + 100;
    const enter = Array.from({ length: n }, (_, i) => ({
      id: asNodeId(`c${i}`),
      sourceKind: 'ancestor' as const,
      source: asNodeId('P'),
    }));
    const ref: RefinementMap = { move: [], enter, exit: [] };

    const fromPos = new Map<NodeId, Rect>([[asNodeId('P'), { x: 0, y: 0, width: 1000, height: 1000 }]]);
    const toPos = new Map<NodeId, Rect>(
      enter.map((e, i) => [e.id, { x: i, y: 0, width: 1, height: 1 }] as const),
    );

    const plan = planTransition({ cut: { members: [] } as never, layout: layout(fromPos) }, { cut: { members: [] } as never, layout: layout(toPos) }, ref);
    expect(plan.mode).toBe('crossfade');
    expect(plan.durationMs).toBe(CROSSFADE_MS);
    expect(plan.enter).toEqual([]);
    const diag = degradeDiag(plan)!;
    expect(diag.trigger).toBe('animated-node-budget');
    expect(diag.triggers).toContain('animated-node-budget');
  });
});

describe('degrade-to-crossfade — trigger 2: sourceless majority', () => {
  it('> 50% of enter+exit sourceless/targetless degrades and names the trigger', () => {
    const ref: RefinementMap = {
      move: [],
      enter: [
        { id: asNodeId('a'), sourceKind: 'none' },
        { id: asNodeId('b'), sourceKind: 'none' },
        { id: asNodeId('c'), sourceKind: 'ancestor', source: asNodeId('P') },
      ],
      exit: [],
    };
    const fromPos = new Map<NodeId, Rect>([[asNodeId('P'), { x: 0, y: 0, width: 10, height: 10 }]]);
    const toPos = new Map<NodeId, Rect>([
      [asNodeId('a'), { x: 0, y: 0, width: 1, height: 1 }],
      [asNodeId('b'), { x: 2, y: 0, width: 1, height: 1 }],
      [asNodeId('c'), { x: 4, y: 0, width: 1, height: 1 }],
    ]);
    const plan = planTransition({ cut: { members: [] } as never, layout: layout(fromPos) }, { cut: { members: [] } as never, layout: layout(toPos) }, ref);
    expect(plan.mode).toBe('crossfade');
    expect(degradeDiag(plan)!.trigger).toBe('sourceless-majority');
  });

  it('exactly 50% sourceless does NOT degrade (strict majority)', () => {
    const ref: RefinementMap = {
      move: [],
      enter: [
        { id: asNodeId('a'), sourceKind: 'none' },
        { id: asNodeId('c'), sourceKind: 'ancestor', source: asNodeId('P') },
      ],
      exit: [],
    };
    const fromPos = new Map<NodeId, Rect>([[asNodeId('P'), { x: 0, y: 0, width: 10, height: 10 }]]);
    const toPos = new Map<NodeId, Rect>([
      [asNodeId('a'), { x: 0, y: 0, width: 1, height: 1 }],
      [asNodeId('c'), { x: 4, y: 0, width: 1, height: 1 }],
    ]);
    const plan = planTransition({ cut: { members: [] } as never, layout: layout(fromPos) }, { cut: { members: [] } as never, layout: layout(toPos) }, ref);
    expect(plan.mode).toBe('choreographed');
  });
});

describe('degrade-to-crossfade — trigger 3: low stability', () => {
  it('teleporting persistent nodes (stability < 0.5) degrades and names the trigger', () => {
    const ids = Array.from({ length: 10 }, (_, i) => asNodeId(`m${i}`));
    const ref: RefinementMap = { move: ids, enter: [], exit: [] };
    // Λ falls back to spacing = 10; move every node 30 world units → d̂ = 3,
    // k = 1 − 3/4 = 0.25 → stability 0.25 < 0.5.
    const fromPos = new Map<NodeId, Rect>(ids.map((n, i) => [n, { x: i * 100, y: 0, width: 1, height: 1 }] as const));
    const toPos = new Map<NodeId, Rect>(ids.map((n, i) => [n, { x: i * 100 + 30, y: 0, width: 1, height: 1 }] as const));

    const plan = planTransition(
      { cut: { members: [] } as never, layout: layout(fromPos), hints: { spacing: 10 } },
      { cut: { members: [] } as never, layout: layout(toPos), hints: { spacing: 10 } },
      ref,
    );
    expect(plan.mode).toBe('crossfade');
    const diag = degradeDiag(plan)!;
    expect(diag.trigger).toBe('low-stability');
    expect(diag.data!.stability).toBeCloseTo(0.25, 6);
  });
});

describe('degrade diagnostics', () => {
  it('a choreographed plan carries counts but no degrade diagnostic', () => {
    const ref: RefinementMap = {
      move: [],
      enter: [{ id: asNodeId('c'), sourceKind: 'ancestor', source: asNodeId('P') }],
      exit: [],
    };
    const fromPos = new Map<NodeId, Rect>([[asNodeId('P'), { x: 0, y: 0, width: 10, height: 10 }]]);
    const toPos = new Map<NodeId, Rect>([[asNodeId('c'), { x: 0, y: 0, width: 2, height: 2 }]]);
    const plan = planTransition({ cut: { members: [] } as never, layout: layout(fromPos) }, { cut: { members: [] } as never, layout: layout(toPos) }, ref);
    expect(plan.mode).toBe('choreographed');
    expect(degradeDiag(plan)).toBeUndefined();
    expect(plan.diagnostics.find((d) => d.code === 'counts')).toBeDefined();
  });
});
