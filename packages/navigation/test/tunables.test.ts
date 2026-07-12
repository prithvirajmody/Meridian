/**
 * 6E tunables: the canonical frozen defaults are the ADR constants (single
 * source), every consumer honors an explicit tunables value, and durations
 * can never escape the constitutional `MAX_TRANSITION_MS` budget (§16.1) no
 * matter what the panel says.
 */
import { describe, expect, it } from 'vitest';
import { asNodeId } from '@meridian/graph-core';
import type { ZoomPolicy } from '@meridian/abstraction';
import type { LayoutResult, NodeId, Point, Rect } from '@meridian/view-model';
import {
  ANCHOR_SNAP_FACTOR,
  BASE_TRANSITION_MS,
  CROSSFADE_MS,
  FRAME_MARGIN,
  KEY_ZOOM_FACTOR,
  MAX_ANIMATED_NODES,
  MAX_TRANSITION_MS,
  OVERZOOM_MAX,
  READABLE_LEAF_PX,
  SOURCELESS_MAJORITY,
  STABILITY_DEGRADE_FLOOR,
} from '../src/constants.js';
import { NAV_TUNABLE_DEFAULTS, type NavTunables } from '../src/tunables.js';
import { planTransition, TransitionChoreographer } from '../src/choreographer.js';
import { selectAnchorNode } from '../src/anchor.js';
import { cameraScaleLimits, deriveScaleRange } from '../src/coupling.js';
import { NavigationController } from '../src/controller.js';
import type { RefinementMap } from '../src/refinement.js';
import { buildSpace, cutOf } from './helpers.js';

function layout(positions: ReadonlyMap<NodeId, Rect>): LayoutResult {
  return { positions, bounds: { x: 0, y: 0, width: 100, height: 100 }, stability: 1 };
}

/** A one-parent → two-children refinement with sane spawn geometry. */
function refinementFixture(): {
  readonly refinement: RefinementMap;
  readonly from: { cut: never; layout: LayoutResult };
  readonly to: { cut: never; layout: LayoutResult };
} {
  const parent = asNodeId('P');
  const refinement: RefinementMap = {
    move: [],
    enter: [
      { id: asNodeId('c1'), sourceKind: 'ancestor', source: parent },
      { id: asNodeId('c2'), sourceKind: 'ancestor', source: parent },
    ],
    exit: [],
  };
  const fromLayout = layout(new Map([[parent, { x: 0, y: 0, width: 100, height: 100 }]]));
  const toLayout = layout(
    new Map<NodeId, Rect>([
      [asNodeId('c1'), { x: 0, y: 0, width: 40, height: 100 }],
      [asNodeId('c2'), { x: 60, y: 0, width: 40, height: 100 }],
    ]),
  );
  return {
    refinement,
    from: { cut: cutOf(['P']) as never, layout: fromLayout },
    to: { cut: cutOf(['c1', 'c2']) as never, layout: toLayout },
  };
}

function withTunables(patch: Partial<NavTunables>): NavTunables {
  return { ...NAV_TUNABLE_DEFAULTS, ...patch };
}

describe('NAV_TUNABLE_DEFAULTS — the single canonical defaults module', () => {
  it('every default is exactly its ADR constant (no second source of values)', () => {
    expect(NAV_TUNABLE_DEFAULTS).toEqual({
      baseTransitionMs: BASE_TRANSITION_MS,
      crossfadeMs: CROSSFADE_MS,
      maxAnimatedNodes: MAX_ANIMATED_NODES,
      stabilityDegradeFloor: STABILITY_DEGRADE_FLOOR,
      sourcelessMajority: SOURCELESS_MAJORITY,
      anchorSnapFactor: ANCHOR_SNAP_FACTOR,
      overzoomMax: OVERZOOM_MAX,
      frameMargin: FRAME_MARGIN,
      keyZoomFactor: KEY_ZOOM_FACTOR,
      readableLeafPx: READABLE_LEAF_PX,
    });
  });

  it('is frozen — a session copy must be edited, never the defaults', () => {
    expect(Object.isFrozen(NAV_TUNABLE_DEFAULTS)).toBe(true);
    expect(() => {
      (NAV_TUNABLE_DEFAULTS as { baseTransitionMs: number }).baseTransitionMs = 1;
    }).toThrow();
  });
});

describe('planTransition honors TransitionTunables (next-plan effect)', () => {
  it('defaults reproduce the ADR plan exactly (omitted arg ≡ defaults)', () => {
    const { refinement, from, to } = refinementFixture();
    expect(planTransition(from, to, refinement)).toEqual(
      planTransition(from, to, refinement, NAV_TUNABLE_DEFAULTS),
    );
    expect(planTransition(from, to, refinement).durationMs).toBe(BASE_TRANSITION_MS);
  });

  it('baseTransitionMs changes a choreographed duration', () => {
    const { refinement, from, to } = refinementFixture();
    const plan = planTransition(from, to, refinement, withTunables({ baseTransitionMs: 120 }));
    expect(plan.mode).toBe('choreographed');
    expect(plan.durationMs).toBe(120);
  });

  it('durations clamp to MAX_TRANSITION_MS — the §16.1 budget is not tunable', () => {
    const { refinement, from, to } = refinementFixture();
    const plan = planTransition(from, to, refinement, withTunables({ baseTransitionMs: 5000 }));
    expect(plan.durationMs).toBe(MAX_TRANSITION_MS);
    const degraded = planTransition(
      from,
      to,
      refinement,
      withTunables({ maxAnimatedNodes: 0, crossfadeMs: 5000 }),
    );
    expect(degraded.mode).toBe('crossfade');
    expect(degraded.durationMs).toBe(MAX_TRANSITION_MS);
  });

  it('maxAnimatedNodes = 1 degrades a 2-enter plan and crossfadeMs sets its duration', () => {
    const { refinement, from, to } = refinementFixture();
    const plan = planTransition(
      from,
      to,
      refinement,
      withTunables({ maxAnimatedNodes: 1, crossfadeMs: 90 }),
    );
    expect(plan.mode).toBe('crossfade');
    expect(plan.durationMs).toBe(90);
    expect(plan.diagnostics.find((d) => d.code === 'degrade-to-crossfade')?.trigger).toBe(
      'animated-node-budget',
    );
  });

  it('stabilityDegradeFloor raised above a perfect score degrades on low-stability', () => {
    const { refinement, from, to } = refinementFixture();
    // stability = 1 here; an (absurd) floor above it must trip the trigger.
    const plan = planTransition(from, to, refinement, withTunables({ stabilityDegradeFloor: 1.5 }));
    expect(plan.mode).toBe('crossfade');
    expect(plan.diagnostics.find((d) => d.code === 'degrade-to-crossfade')?.triggers).toContain(
      'low-stability',
    );
  });

  it('sourcelessMajority = 0 makes a single sourceless enter degrade', () => {
    const parent = asNodeId('P');
    const refinement: RefinementMap = {
      move: [],
      enter: [
        { id: asNodeId('c1'), sourceKind: 'ancestor', source: parent },
        { id: asNodeId('s1'), sourceKind: 'none' },
      ],
      exit: [],
    };
    const from = {
      cut: cutOf(['P']) as never,
      layout: layout(new Map([[parent, { x: 0, y: 0, width: 100, height: 100 }]])),
    };
    const to = {
      cut: cutOf(['c1', 's1']) as never,
      layout: layout(
        new Map<NodeId, Rect>([
          [asNodeId('c1'), { x: 0, y: 0, width: 40, height: 100 }],
          [asNodeId('s1'), { x: 60, y: 0, width: 40, height: 100 }],
        ]),
      ),
    };
    // 1 of 2 = 50% — NOT a strict majority under the default, so it choreographs…
    expect(planTransition(from, to, refinement).mode).toBe('choreographed');
    // …but with the threshold tuned to 0 the same diff degrades.
    const plan = planTransition(from, to, refinement, withTunables({ sourcelessMajority: 0 }));
    expect(plan.mode).toBe('crossfade');
    expect(plan.diagnostics.find((d) => d.code === 'degrade-to-crossfade')?.triggers).toContain(
      'sourceless-majority',
    );
  });

  it('TransitionChoreographer.plan forwards tunables', () => {
    const { refinement, from, to } = refinementFixture();
    const plan = new TransitionChoreographer().plan(
      from,
      to,
      refinement,
      withTunables({ baseTransitionMs: 77 }),
    );
    expect(plan.durationMs).toBe(77);
  });
});

describe('selectAnchorNode honors the ANCHOR_SNAP factor', () => {
  const cut = cutOf(['A']);
  const positions = new Map<NodeId, Rect>([[asNodeId('A'), { x: 0, y: 0, width: 10, height: 10 }]]);
  const near: Point = { x: 14, y: 5 }; // 4 world units from A's boundary
  const lambda = 10; // default snap radius = 0.5·Λ = 5 → the miss snaps

  it('default factor snaps a near-miss within 0.5·Λ', () => {
    expect(selectAnchorNode(cut, layout(positions), near, lambda)).toEqual({
      node: asNodeId('A'),
      snapped: true,
    });
  });

  it('factor 0 disables snapping (strict containment only)', () => {
    expect(selectAnchorNode(cut, layout(positions), near, lambda, 0)).toEqual({
      node: undefined,
      snapped: false,
    });
  });

  it('a larger factor tracks a farther miss', () => {
    const far: Point = { x: 28, y: 5 }; // 18 > 0.5·Λ, misses under the default…
    expect(selectAnchorNode(cut, layout(positions), far, lambda).node).toBeUndefined();
    // …but snaps at factor 2 (radius 20).
    expect(selectAnchorNode(cut, layout(positions), far, lambda, 2).node).toBe(asNodeId('A'));
  });
});

describe('deriveScaleRange honors readableLeafPx and frameMargin', () => {
  const bounds: Rect = { x: 0, y: 0, width: 1000, height: 1000 };
  const viewport = { width: 500, height: 500 };

  it('readableLeafPx scales sMax proportionally', () => {
    const base = deriveScaleRange(bounds, viewport, { leafWorldSize: 50 });
    const doubled = deriveScaleRange(bounds, viewport, { leafWorldSize: 50, readableLeafPx: 2 * READABLE_LEAF_PX });
    expect(doubled.sMax).toBeCloseTo(2 * base.sMax, 12);
    expect(doubled.sMin).toBe(base.sMin);
  });

  it('frameMargin moves the fit-all end (sMin)', () => {
    const base = deriveScaleRange(bounds, viewport, { leafWorldSize: 50 });
    const roomier = deriveScaleRange(bounds, viewport, { leafWorldSize: 50, frameMargin: 0.3 });
    expect(base.sMin).toBeCloseTo(viewport.width / (bounds.width * (1 + 2 * FRAME_MARGIN)), 12);
    expect(roomier.sMin).toBeCloseTo(viewport.width / (bounds.width * 1.6), 12);
    expect(roomier.sMin).toBeLessThan(base.sMin);
  });
});

describe('NavigationController reads live ControllerTunables at each verb', () => {
  const space = buildSpace([
    { id: 'A', children: [{ id: 'a1' }, { id: 'a2' }] },
    { id: 'B', children: [{ id: 'b1' }, { id: 'b2' }] },
  ]);
  const policy: ZoomPolicy = { thresholds: [0.5], hysteresis: 0.2 };
  const viewport = { width: 100, height: 100 };
  const anchor: Point = { x: 50, y: 50 };
  const range = { sMin: 1, sMax: 100 };

  it('overzoomMax caps the camera live — an edit applies to the NEXT gesture', () => {
    let overzoomMax = OVERZOOM_MAX;
    const ctrl = new NavigationController({
      space,
      policy,
      viewport,
      scaleRange: range,
      tunables: () => ({ overzoomMax, keyZoomFactor: KEY_ZOOM_FACTOR }),
    });
    ctrl.zoomBy(1e9, anchor); // saturate far past sMax
    expect(ctrl.camera().scale).toBeCloseTo(range.sMax * OVERZOOM_MAX, 9);

    overzoomMax = 2; // the "panel" edits the session copy…
    ctrl.zoomBy(1e9, anchor); // …and the next gesture clamps tighter
    expect(ctrl.camera().scale).toBeCloseTo(range.sMax * 2, 9);
    expect(cameraScaleLimits(range, 2).max).toBeCloseTo(range.sMax * 2, 12);
  });

  it('keyZoomFactor drives zoomIn live; the explicit option wins when set', () => {
    let keyZoomFactor = 2;
    const tunables = () => ({ overzoomMax: OVERZOOM_MAX, keyZoomFactor });
    const ctrl = new NavigationController({ space, policy, viewport, scaleRange: range, tunables });
    const s0 = ctrl.camera().scale;
    ctrl.zoomIn();
    expect(ctrl.camera().scale).toBeCloseTo(s0 * 2, 9);
    keyZoomFactor = 3;
    const s1 = ctrl.camera().scale;
    ctrl.zoomIn();
    expect(ctrl.camera().scale).toBeCloseTo(s1 * 3, 9);

    const pinned = new NavigationController({
      space,
      policy,
      viewport,
      scaleRange: range,
      keyZoomFactor: 1.5,
      tunables,
    });
    const p0 = pinned.camera().scale;
    pinned.zoomIn();
    expect(pinned.camera().scale).toBeCloseTo(p0 * 1.5, 9);
  });

  it('defaults to the frozen ADR values when no provider is given', () => {
    const ctrl = new NavigationController({ space, policy, viewport, scaleRange: range });
    ctrl.zoomBy(1e9, anchor);
    expect(ctrl.camera().scale).toBeCloseTo(range.sMax * OVERZOOM_MAX, 9);
    const s = ctrl.camera().scale;
    ctrl.zoomOut();
    expect(ctrl.camera().scale).toBeCloseTo(s / KEY_ZOOM_FACTOR, 9);
  });
});
