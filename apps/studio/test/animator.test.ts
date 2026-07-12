/**
 * Pure transition animator (6D): easing, the anchored camera path (ADR-0024 —
 * drift must be ~0 by construction), transition-frame sampling (ADR-0023
 * enter/exit/move geometry + alpha lanes), retarget snapshots, and the runtime
 * guard state machine. Everything here is deterministic — same inputs, same
 * lanes.
 */
import { describe, expect, it } from 'vitest';
import type { NodeAnim, TransitionPlan } from '@meridian/navigation';
import {
  buildRenderModel,
  worldToScreen,
  type NodeId,
  type Rect,
} from '@meridian/view-model';
import type { Cut, LodResult } from '@meridian/abstraction';
import {
  anchorDriftPx,
  easeInOutCubic,
  GUARD_FRAME_BUDGET_MS,
  GUARD_INITIAL,
  guardStep,
  logLerp,
  prepareTransition,
  sampleCameraPath,
  sampleTransitionModel,
  snapshotFlightLayout,
  type CameraPath,
} from '../src/transition/animator.js';

const VIEWPORT = { width: 1000, height: 800 };

function id(value: string): NodeId {
  return value as NodeId;
}

function rect(x: number, y: number, width = 10, height = 10): Rect {
  return { x, y, width, height };
}

/** A tiny settled RenderModel via the real builder (empty snapshot is fine —
 * missing semantic nodes only produce diagnostics). */
function model(nodes: readonly (readonly [string, Rect])[]): ReturnType<typeof buildRenderModel> {
  const members = nodes.map(([n]) => id(n));
  const cut = {
    level: 0,
    members,
    trace: new Map(),
    coverage: { leaves: members.length, coveredLeaves: members.length, covers: true },
  } as unknown as Cut;
  const lod = {
    cut,
    inducedEdges: [],
    cappedEdges: [],
    frontier: { expandable: [], collapsible: [] },
    provenance: { level: 0 },
  } as unknown as LodResult;
  const positions = new Map<NodeId, Rect>(nodes.map(([n, r]) => [id(n), r]));
  const layout = { positions, bounds: rect(0, 0, 100, 100), stability: 1 };
  return buildRenderModel({ graphs: new Map(), roots: [] }, lod, layout);
}

function plan(partial: Partial<TransitionPlan> & { mode: TransitionPlan['mode'] }): TransitionPlan {
  return {
    enter: [],
    exit: [],
    move: [],
    durationMs: 240,
    diagnostics: [],
    ...partial,
  };
}

describe('easing', () => {
  it('easeInOutCubic hits the endpoints, is monotone, and clamps', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 10);
    expect(easeInOutCubic(-1)).toBe(0);
    expect(easeInOutCubic(2)).toBe(1);
    let previous = 0;
    for (let t = 0; t <= 1.0001; t += 0.01) {
      const value = easeInOutCubic(t);
      expect(value).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = value;
    }
  });

  it('logLerp interpolates scale multiplicatively', () => {
    expect(logLerp(1, 4, 0.5)).toBeCloseTo(2, 10);
    expect(logLerp(2, 2, 0.7)).toBeCloseTo(2, 10);
  });
});

describe('anchored camera path (ADR-0024)', () => {
  const path: CameraPath = {
    from: { center: { x: 0, y: 0 }, scale: 2 },
    to: { center: { x: 37, y: -12 }, scale: 8 },
    anchor: {
      screen: { x: 620, y: 180 },
      worldOut: { x: 60, y: -45 },
      worldIn: { x: 55, y: -40 },
    },
  };

  it('holds the interpolated anchor point on the anchored screen point at every sample', () => {
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const e = easeInOutCubic(t);
      const camera = sampleCameraPath(path, VIEWPORT, e);
      expect(anchorDriftPx(path, VIEWPORT, e, camera)).toBeLessThan(1e-6);
    }
  });

  it('starts at the outgoing camera anchor-equivalently and ends exactly at the solve', () => {
    const start = sampleCameraPath(path, VIEWPORT, 0);
    expect(start.scale).toBeCloseTo(path.from.scale, 10);
    // At e=0 the anchored center re-solve must reproduce where the outgoing
    // camera put the anchor world point.
    const screenAtStart = worldToScreen(path.anchor!.worldOut, start, VIEWPORT);
    expect(screenAtStart.x).toBeCloseTo(path.anchor!.screen.x, 6);
    expect(screenAtStart.y).toBeCloseTo(path.anchor!.screen.y, 6);
    const end = sampleCameraPath(path, VIEWPORT, 1);
    expect(end.scale).toBeCloseTo(path.to.scale, 10);
  });

  it('lerps center and log-lerps scale when unanchored', () => {
    const free: CameraPath = { from: path.from, to: path.to };
    const mid = sampleCameraPath(free, VIEWPORT, 0.5);
    expect(mid.center.x).toBeCloseTo((path.from.center.x + path.to.center.x) / 2, 10);
    expect(mid.scale).toBeCloseTo(Math.sqrt(path.from.scale * path.to.scale), 10);
    expect(anchorDriftPx(free, VIEWPORT, 0.5, mid)).toBe(0);
  });
});

describe('choreographed sampling (ADR-0023)', () => {
  const fromModel = model([
    ['parent', rect(0, 0, 40, 40)],
    ['mover', rect(80, 80, 10, 10)],
    ['gone', rect(50, 0, 10, 10)],
  ]);
  const toModel = model([
    ['child-a', rect(0, 0, 10, 10)],
    ['child-b', rect(20, 20, 10, 10)],
    ['mover', rect(90, 60, 10, 10)],
  ]);
  const enterA: NodeAnim = { id: id('child-a'), fromRect: rect(0, 0, 20, 20), toRect: rect(0, 0, 10, 10), fadeIn: true };
  const enterB: NodeAnim = { id: id('child-b'), fromRect: rect(10, 10, 20, 20), toRect: rect(20, 20, 10, 10), fadeIn: true };
  const move: NodeAnim = { id: id('mover'), fromRect: rect(80, 80, 10, 10), toRect: rect(90, 60, 10, 10) };
  const exit: NodeAnim = { id: id('gone'), fromRect: rect(50, 0, 10, 10), toRect: rect(10, 10, 4, 4), fadeOut: true };
  const choreographed = plan({ mode: 'choreographed', enter: [enterA, enterB], move: [move], exit: [exit] });

  it('interpolates enter/move/exit rects and fades alphas', () => {
    const prepared = prepareTransition(fromModel, toModel, choreographed);
    const half = sampleTransitionModel(prepared, 0.5);
    const index = new Map(half.nodeIds.map((n, i) => [n, i] as const));

    const ia = index.get(id('child-a'))!;
    expect(half.nodeRects[ia * 4 + 2]).toBeCloseTo(15, 10); // 20→10 at 0.5
    expect(half.nodeAlphas![ia]).toBeCloseTo(0.5, 6);

    const im = index.get(id('mover'))!;
    expect(half.nodeRects[im * 4]).toBeCloseTo(85, 10);
    expect(half.nodeRects[im * 4 + 1]).toBeCloseTo(70, 10);
    expect(half.nodeAlphas![im]).toBe(1);

    const ig = index.get(id('gone'))!;
    expect(ig).toBeGreaterThanOrEqual(toModel.nodeIds.length); // appended exit
    expect(half.nodeRects[ig * 4]).toBeCloseTo(30, 10); // 50→10 at 0.5
    expect(half.nodeAlphas![ig]).toBeCloseTo(0.5, 6);
  });

  it('is deterministic and reaches exact endpoints', () => {
    const prepared = prepareTransition(fromModel, toModel, choreographed);
    const a = sampleTransitionModel(prepared, 0.37);
    const b = sampleTransitionModel(prepared, 0.37);
    expect([...a.nodeRects]).toEqual([...b.nodeRects]);
    expect([...a.nodeAlphas!]).toEqual([...b.nodeAlphas!]);
    const done = sampleTransitionModel(prepared, 1);
    const index = new Map(done.nodeIds.map((n, i) => [n, i] as const));
    const ia = index.get(id('child-a'))!;
    expect(done.nodeRects[ia * 4 + 2]).toBe(10);
    expect(done.nodeAlphas![index.get(id('gone'))!]).toBe(0);
  });

  it('keeps merged color/label tables addressable for appended exits', () => {
    const prepared = prepareTransition(fromModel, toModel, choreographed);
    const sampled = sampleTransitionModel(prepared, 0.5);
    const ig = sampled.nodeIds.indexOf(id('gone'));
    const label = sampled.labelTable[sampled.labelRefs[ig]!];
    expect(label).toBe('gone');
  });

  it('snapshotFlightLayout returns interpolated rects for every visible node', () => {
    const prepared = prepareTransition(fromModel, toModel, choreographed);
    const snap = snapshotFlightLayout(prepared, 0.5);
    expect(new Set(snap.members)).toEqual(new Set(['child-a', 'child-b', 'mover', 'gone']));
    expect(snap.positions.get(id('mover'))!.x).toBeCloseTo(85, 10);
  });
});

describe('crossfade sampling (ADR-0023 degrade)', () => {
  const fromModel = model([['old-1', rect(0, 0)], ['old-2', rect(30, 30)]]);
  const toModel = model([['new-1', rect(60, 60)]]);

  it('fades the whole outgoing frame into the incoming frame', () => {
    const prepared = prepareTransition(fromModel, toModel, plan({ mode: 'crossfade', durationMs: 160 }));
    const third = sampleTransitionModel(prepared, 0.25);
    const index = new Map(third.nodeIds.map((n, i) => [n, i] as const));
    expect(third.nodeAlphas![index.get(id('new-1'))!]).toBeCloseTo(0.25, 6);
    expect(third.nodeAlphas![index.get(id('old-1'))!]).toBeCloseTo(0.75, 6);
    expect(third.nodeAlphas![index.get(id('old-2'))!]).toBeCloseTo(0.75, 6);
    // Outgoing rects never move in a crossfade.
    expect(third.nodeRects[index.get(id('old-2'))! * 4]).toBe(30);
  });

  it('compounds base alpha when the outgoing frame was itself mid-fade (guard finish-fade)', () => {
    const prepared = prepareTransition(fromModel, toModel, plan({ mode: 'crossfade' }));
    const mid = sampleTransitionModel(prepared, 0.5);
    const prepared2 = prepareTransition(mid, toModel, plan({ mode: 'crossfade', durationMs: 100 }));
    const sampled = sampleTransitionModel(prepared2, 0.5);
    const index = new Map(sampled.nodeIds.map((n, i) => [n, i] as const));
    // old-1 was at alpha 0.5 in the snapshot; halfway through the fade it is 0.25.
    const appendedOld = sampled.nodeIds.lastIndexOf(id('old-1'));
    expect(sampled.nodeAlphas![appendedOld]).toBeCloseTo(0.25, 6);
    expect(index.size).toBeGreaterThan(0);
  });
});

describe('runtime guard (ADR-0023)', () => {
  it('trips only after three consecutive frames over budget', () => {
    let state = GUARD_INITIAL;
    state = guardStep(state, GUARD_FRAME_BUDGET_MS + 5);
    state = guardStep(state, GUARD_FRAME_BUDGET_MS + 5);
    expect(state.tripped).toBe(false);
    state = guardStep(state, 3); // fast frame resets the streak
    state = guardStep(state, 30);
    state = guardStep(state, 30);
    expect(state.tripped).toBe(false);
    state = guardStep(state, 30);
    expect(state.tripped).toBe(true);
    // Latched once tripped.
    expect(guardStep(state, 1).tripped).toBe(true);
  });
});
