import { describe, expect, it, vi } from 'vitest';
import { screenToWorld } from '@meridian/view-model';
import {
  GeometricCameraController,
  createCameraController,
  fitCameraToBounds,
} from '../src/camera-controller.js';

describe('fitCameraToBounds', () => {
  it('centers and fits bounds into CSS-pixel padding, clamped to limits', () => {
    expect(
      fitCameraToBounds(
        { center: { x: 0, y: 0 }, scale: 1 },
        { x: 100, y: -50, width: 200, height: 100 },
        { width: 1000, height: 700 },
        { min: 0.25, max: 3 },
        { padding: 50 },
      ),
    ).toEqual({ center: { x: 200, y: 0 }, scale: 3 });
  });

  it('handles empty, point-sized, and zero-viewport scenes deterministically', () => {
    const camera = { center: { x: 7, y: 9 }, scale: 2 };
    expect(fitCameraToBounds(camera, null, { width: 0, height: 0 })).toEqual(camera);
    expect(
      fitCameraToBounds(camera, { x: 40, y: 50, width: 0, height: 0 }, { width: 0, height: 0 }),
    ).toEqual({ center: { x: 40, y: 50 }, scale: 2 });
  });

  it('uses the non-degenerate axis when the other bounds axis is zero', () => {
    expect(
      fitCameraToBounds(
        { center: { x: 0, y: 0 }, scale: 1 },
        { x: 3, y: 5, width: 0, height: 100 },
        { width: 800, height: 600 },
        { min: 0.1, max: 100 },
        { padding: 50 },
      ),
    ).toEqual({ center: { x: 3, y: 55 }, scale: 5 });
  });
});

describe('GeometricCameraController', () => {
  it('pans in CSS pixels and emits immutable snapshots', () => {
    const controller = createCameraController({
      initialState: { center: { x: 20, y: 30 }, scale: 2 },
      viewport: { width: 800, height: 600 },
      devicePixelRatio: 2,
    });
    const observed: Array<ReturnType<typeof controller.state>> = [];
    controller.on('change', (state) => observed.push(state));

    controller.panBy({ x: 10, y: -8 });
    expect(controller.state()).toEqual({ center: { x: 15, y: 34 }, scale: 2 });
    expect(observed).toEqual([{ center: { x: 15, y: 34 }, scale: 2 }]);

    (observed[0]!.center as { x: number }).x = 999;
    expect(controller.state().center.x).toBe(15);
  });

  it('keeps the anchored world point stable while zooming and clamps scale', () => {
    const controller = createCameraController({
      initialState: { center: { x: 20, y: 30 }, scale: 2 },
      viewport: { width: 800, height: 600 },
      scaleLimits: { min: 0.5, max: 3 },
    });
    const anchor = { x: 123, y: 456 };
    const before = screenToWorld(anchor, controller.state(), controller.viewport());

    controller.zoomAt(anchor, 10);

    expect(controller.state().scale).toBe(3);
    const after = screenToWorld(anchor, controller.state(), controller.viewport());
    expect(after.x).toBeCloseTo(before.x, 12);
    expect(after.y).toBeCloseTo(before.y, 12);
  });

  it('resizes in CSS pixels while keeping DPR out of camera geometry', () => {
    const controller = new GeometricCameraController({
      viewport: { width: 400, height: 300 },
      devicePixelRatio: 1,
    });
    const changed = vi.fn();
    controller.on('change', changed);

    controller.resize({ width: 800, height: 600 }, 3);

    expect(controller.viewport()).toEqual({ width: 800, height: 600, devicePixelRatio: 3 });
    expect(controller.state()).toEqual({ center: { x: 0, y: 0 }, scale: 1 });
    expect(changed).toHaveBeenCalledTimes(1);
    controller.resize({ width: 800, height: 600 }, 3);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('fits content and safely no-ops for a zero-node graph', () => {
    const controller = createCameraController({
      viewport: { width: 1000, height: 700 },
      scaleLimits: { min: 0.1, max: 100 },
    });
    const changed = vi.fn();
    controller.on('change', changed);

    controller.fitToBounds(null);
    expect(changed).not.toHaveBeenCalled();

    controller.fitToBounds({ x: -100, y: 20, width: 200, height: 100 }, { padding: 50 });
    expect(controller.state()).toEqual({ center: { x: 0, y: 70 }, scale: 4.5 });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes listeners and destroys idempotently', () => {
    const controller = createCameraController();
    const listener = vi.fn();
    const unsubscribe = controller.on('change', listener);
    unsubscribe();
    controller.panBy({ x: 1, y: 1 });
    expect(listener).not.toHaveBeenCalled();

    controller.destroy();
    controller.destroy();
    expect(() => controller.panBy({ x: 1, y: 1 })).toThrow('destroyed');
  });

  it('rejects non-finite and degenerate inputs with located errors', () => {
    expect(() => createCameraController({ devicePixelRatio: 0 })).toThrow('devicePixelRatio');
    expect(() =>
      fitCameraToBounds(
        { center: { x: 0, y: 0 }, scale: 1 },
        { x: 0, y: 0, width: -1, height: 0 },
        { width: 1, height: 1 },
      ),
    ).toThrow('bounds dimensions');
    expect(() =>
      createCameraController({ viewport: { width: Number.NaN, height: 0 } }),
    ).toThrow('viewport.width');
  });
});
