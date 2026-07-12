/**
 * The hysteresis state machine and the saturation rule, driven against the
 * **real** `LodResolver` (ROADMAP 6C exit criterion). The flagship acceptance
 * test: oscillating the zoom scalar across a threshold produces ZERO cut-flaps
 * (ROADMAP §11). Plus ADR-0025 saturation: zoom-in at z=1 never drills; zoom-out
 * at z=0 never pops the context.
 */
import { describe, expect, it } from 'vitest';
import type { ZoomPolicy } from '@meridian/abstraction';
import type { Point } from '@meridian/view-model';
import { NavigationController } from '../src/controller.js';
import { OVERZOOM_MAX } from '../src/constants.js';
import { buildSpace } from './helpers.js';

const SPACE = buildSpace([
  { id: 'A', children: [{ id: 'a1' }, { id: 'a2' }] },
  { id: 'B', children: [{ id: 'b1' }, { id: 'b2' }] },
]);
const POLICY: ZoomPolicy = { thresholds: [0.5], hysteresis: 0.2 };
const VIEWPORT = { width: 100, height: 100 };
const ANCHOR: Point = { x: 50, y: 50 };

function newController(initialZoom: number) {
  return new NavigationController({ space: SPACE, policy: POLICY, viewport: VIEWPORT, initialZoom });
}

describe('hysteresis state machine — zero cut-flaps (ROADMAP §11)', () => {
  it('oscillating across the threshold from level 1 never changes the cut', () => {
    const ctrl = newController(0);
    // Settle decisively at level 1 (z ≥ 0.5 + h/2 = 0.6).
    ctrl.zoomTo(0.7, ANCHOR);
    expect(ctrl.context().level).toBe(1);

    let flaps = 0;
    const off = ctrl.on('cutchange', () => flaps++);
    // Oscillate around the 0.5 threshold, staying inside the hysteresis band.
    for (let i = 0; i < 50; i++) {
      ctrl.zoomTo(i % 2 === 0 ? 0.45 : 0.55, ANCHOR);
      expect(ctrl.context().level).toBe(1); // sticky — never drops
    }
    off();
    expect(flaps).toBe(0);
  });

  it('oscillating across the threshold from level 0 never changes the cut', () => {
    const ctrl = newController(0);
    ctrl.zoomTo(0.3, ANCHOR);
    expect(ctrl.context().level).toBe(0);

    let flaps = 0;
    ctrl.on('cutchange', () => flaps++);
    for (let i = 0; i < 50; i++) {
      ctrl.zoomTo(i % 2 === 0 ? 0.45 : 0.55, ANCHOR);
      expect(ctrl.context().level).toBe(0); // sticky — never rises
    }
    expect(flaps).toBe(0);
  });

  it('a decisive crossing past the hysteresis band does change the cut', () => {
    const ctrl = newController(0);
    ctrl.zoomTo(0.7, ANCHOR); // → level 1
    let flaps = 0;
    ctrl.on('cutchange', () => flaps++);
    ctrl.zoomTo(0.3, ANCHOR); // z < 0.5 − h/2 = 0.4 → down to level 0
    expect(ctrl.context().level).toBe(0);
    expect(flaps).toBe(1);
  });
});

describe('saturation — zoom never changes scope (ADR-0025)', () => {
  it('zoom-in gestures at z = 1 never drill or move the cut, only overzoom the camera', () => {
    const ctrl = new NavigationController({ space: SPACE, policy: POLICY, viewport: VIEWPORT, initialZoom: 1 });
    expect(ctrl.zoom()).toBe(1);
    const before = ctrl.context().cutMembers.join(' ');

    let flaps = 0;
    ctrl.on('cutchange', () => flaps++);
    for (let i = 0; i < 12; i++) ctrl.zoomBy(2, ANCHOR);

    expect(ctrl.zoom()).toBe(1); // scalar pinned
    expect(ctrl.context().depth).toBe(1); // never drilled
    expect(ctrl.context().cutMembers.join(' ')).toBe(before);
    expect(flaps).toBe(0);
    // Camera crisped up to OVERZOOM_MAX past s_max, then clamped there.
    expect(ctrl.camera().scale).toBeLessThanOrEqual(1000 * OVERZOOM_MAX + 1e-6);
    const saturated = ctrl.camera().scale;
    ctrl.zoomBy(2, ANCHOR);
    expect(ctrl.camera().scale).toBeCloseTo(saturated, 9); // idempotent at the limit
  });

  it('zoom-out gestures at z = 0 never pop the context, only overzoom out', () => {
    const ctrl = newController(0);
    expect(ctrl.zoom()).toBe(0);
    let flaps = 0;
    ctrl.on('cutchange', () => flaps++);
    for (let i = 0; i < 12; i++) ctrl.zoomBy(0.5, ANCHOR);
    expect(ctrl.zoom()).toBe(0);
    expect(ctrl.context().depth).toBe(1); // no pop
    expect(flaps).toBe(0);
    expect(ctrl.camera().scale).toBeGreaterThanOrEqual(1 / OVERZOOM_MAX - 1e-9);
  });
});
