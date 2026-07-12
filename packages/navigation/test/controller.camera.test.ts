/**
 * 6D controller seams: `panBy` (no resolve, no events), `setCamera` (exact
 * camera, z re-derived, cutchange on member change), `drillOutTo` (breadcrumb
 * multi-pop), `updateScaleRange` (the ADR-0025 amendment's post-layout range
 * wiring), and `currentSpace`.
 */
import { describe, expect, it } from 'vitest';
import { asNodeId } from '@meridian/graph-core';
import type { ZoomPolicy } from '@meridian/abstraction';
import { NavigationController } from '../src/controller.js';
import { buildSpace, type Spec } from './helpers.js';

const TREE: readonly Spec[] = [
  {
    id: 'a',
    children: [
      { id: 'a1', children: [{ id: 'a1x' }, { id: 'a1y' }] },
      { id: 'a2' },
    ],
  },
  { id: 'b', children: [{ id: 'b1' }, { id: 'b2' }] },
];

const POLICY: ZoomPolicy = {
  thresholds: [1 / 3, 2 / 3],
  hysteresis: 0.05,
  budget: { maxNodes: 10_000, fanOut: 32 },
};

function controller(initialZoom = 0): NavigationController {
  return new NavigationController({
    space: buildSpace(TREE),
    policy: POLICY,
    viewport: { width: 1000, height: 800 },
    scaleRange: { sMin: 1, sMax: 100 },
    initialZoom,
  });
}

describe('panBy', () => {
  it('moves the camera center without resolving or emitting', () => {
    const nav = controller(0.5);
    const before = nav.camera();
    const cutBefore = nav.currentCut()!.members;
    let events = 0;
    nav.on('cutchange', () => events++);
    nav.panBy({ x: 100, y: -50 });
    const after = nav.camera();
    expect(after.scale).toBe(before.scale);
    expect(after.center.x).toBeCloseTo(before.center.x - 100 / before.scale, 10);
    expect(after.center.y).toBeCloseTo(before.center.y + 50 / before.scale, 10);
    expect(nav.currentCut()!.members).toEqual(cutBefore);
    expect(events).toBe(0);
    expect(nav.zoom()).toBeCloseTo(0.5, 10);
  });
});

describe('setCamera', () => {
  it('adopts the exact camera and re-derives z through the coupling', () => {
    const nav = controller(0);
    nav.setCamera({ center: { x: 12, y: 34 }, scale: 100 }); // sMax ⇒ z = 1
    expect(nav.camera().center).toEqual({ x: 12, y: 34 });
    expect(nav.camera().scale).toBe(100);
    expect(nav.zoom()).toBe(1);
  });

  it('emits cutchange when the re-resolve changes members', () => {
    const nav = controller(0);
    const coarse = nav.currentCut()!.members;
    let events = 0;
    nav.on('cutchange', () => events++);
    nav.setCamera({ center: { x: 0, y: 0 }, scale: 100 });
    expect(events).toBe(1);
    expect(nav.currentCut()!.members).not.toEqual(coarse);
  });

  it('center-only writes (the ADR-0024 solve) never move the cut', () => {
    const nav = controller(0.5);
    const members = nav.currentCut()!.members;
    let events = 0;
    nav.on('cutchange', () => events++);
    const camera = nav.camera();
    nav.setCamera({ center: { x: camera.center.x + 5, y: camera.center.y - 3 }, scale: camera.scale });
    expect(events).toBe(0);
    expect(nav.currentCut()!.members).toEqual(members);
  });
});

describe('drillOutTo', () => {
  it('pops several frames to the requested depth (breadcrumb click)', () => {
    const nav = controller(0);
    nav.drillInto(asNodeId('a'));
    nav.drillInto(asNodeId('a1'));
    expect(nav.context().depth).toBe(3);
    nav.drillOutTo(1);
    expect(nav.context().depth).toBe(1);
    expect(nav.lastNotice()).toBeUndefined();
  });

  it('is a located no-op at or beyond the current depth and on bad input', () => {
    const nav = controller(0);
    nav.drillInto(asNodeId('a'));
    nav.drillOutTo(2);
    expect(nav.lastNotice()?.code).toBe('at-root');
    expect(nav.context().depth).toBe(2);
    nav.drillOutTo(0);
    expect(nav.lastNotice()?.code).toBe('at-root');
    nav.drillOutTo(1.5);
    expect(nav.lastNotice()?.code).toBe('at-root');
    expect(nav.context().depth).toBe(2);
  });
});

describe('updateScaleRange', () => {
  it("preserve 'z' keeps the cut and re-derives the camera scale", () => {
    const nav = controller(0.5);
    const members = nav.currentCut()!.members;
    const z = nav.zoom();
    let events = 0;
    nav.on('cutchange', () => events++);
    nav.updateScaleRange({ sMin: 2, sMax: 400 }, 'z');
    expect(events).toBe(0);
    expect(nav.zoom()).toBeCloseTo(z, 10);
    expect(nav.currentCut()!.members).toEqual(members);
    // s = exp(ln 2 + z·(ln 400 − ln 2))
    expect(nav.camera().scale).toBeCloseTo(Math.exp(Math.log(2) + z * Math.log(200)), 10);
  });

  it("preserve 'scale' re-derives z and re-resolves", () => {
    const nav = controller(0);
    const scale = nav.camera().scale; // sMin = 1 under the old range
    nav.updateScaleRange({ sMin: 0.01, sMax: 1 }, 'scale');
    expect(nav.camera().scale).toBe(scale);
    expect(nav.zoom()).toBe(1); // old sMin is the new sMax
  });
});

describe('currentSpace', () => {
  it('returns the drilled sub-space, then the root space after drill-out', () => {
    const nav = controller(0);
    const rootGraphs = nav.currentSpace().graphs.size;
    nav.drillInto(asNodeId('a'));
    expect(nav.currentSpace().graphs.size).toBeLessThan(rootGraphs);
    nav.drillOut();
    expect(nav.currentSpace().graphs.size).toBe(rootGraphs);
  });
});
