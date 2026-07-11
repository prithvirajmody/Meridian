import { describe, expect, it } from 'vitest';
import {
  createCameraState,
  panBy,
  screenToWorld,
  worldToScreen,
  zoomAt,
} from '../src/index.js';

const viewport = { width: 800, height: 600 };

describe('camera math', () => {
  it('round-trips world ↔ screen in the y-down scale+translate space', () => {
    const camera = createCameraState({ x: 100, y: -20 }, 2.5);
    const world = { x: 132, y: 44 };
    const screen = worldToScreen(world, camera, viewport);
    expect(screen).toEqual({ x: 480, y: 460 });
    expect(screenToWorld(screen, camera, viewport)).toEqual(world);
  });

  it('pans in screen pixels so content follows the drag', () => {
    const camera = createCameraState({ x: 20, y: 30 }, 2);
    expect(panBy(camera, { x: 10, y: -8 })).toEqual({
      center: { x: 15, y: 34 },
      scale: 2,
    });
    expect(camera).toEqual({ center: { x: 20, y: 30 }, scale: 2 });
  });

  it('zoomAt preserves the world point under an off-center cursor, including clamping', () => {
    const camera = createCameraState({ x: 20, y: 30 }, 2);
    const anchor = { x: 123, y: 456 };
    const before = screenToWorld(anchor, camera, viewport);
    const zoomed = zoomAt(camera, anchor, 10, viewport, { min: 0.5, max: 3 });
    expect(zoomed.scale).toBe(3);
    const after = screenToWorld(anchor, zoomed, viewport);
    expect(after.x).toBeCloseTo(before.x, 12);
    expect(after.y).toBeCloseTo(before.y, 12);
  });

  it('rejects non-finite/degenerate camera requests with located errors', () => {
    expect(() => createCameraState({ x: 0, y: 0 }, 0)).toThrow('camera.scale');
    expect(() => zoomAt(createCameraState(), { x: 0, y: 0 }, -1, viewport)).toThrow(
      'zoom factor',
    );
    expect(() => worldToScreen({ x: Number.NaN, y: 0 }, createCameraState(), viewport)).toThrow(
      'world point.x',
    );
  });
});
