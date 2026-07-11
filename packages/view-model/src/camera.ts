/** Pure geometric camera math (ROADMAP Phase 5 §5; semantic zoom is P6). */
import type { Point } from './coords.js';

/** Camera scale is CSS pixels per world unit; center is a world-space point. */
export interface CameraState {
  readonly center: Point;
  readonly scale: number;
}

/** Viewport size in CSS pixels (never backing-store/device pixels). */
export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

export interface CameraScaleLimits {
  readonly min: number;
  readonly max: number;
}

export const DEFAULT_CAMERA_SCALE_LIMITS: CameraScaleLimits = {
  min: 0.0001,
  max: 10_000,
};

function finite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`view-model: ${name} must be finite`);
}

function validateCamera(camera: CameraState): void {
  finite(camera.center.x, 'camera.center.x');
  finite(camera.center.y, 'camera.center.y');
  finite(camera.scale, 'camera.scale');
  if (camera.scale <= 0) throw new RangeError('view-model: camera.scale must be greater than zero');
}

function validateViewport(viewport: ViewportSize): void {
  finite(viewport.width, 'viewport.width');
  finite(viewport.height, 'viewport.height');
  if (viewport.width < 0 || viewport.height < 0) {
    throw new RangeError('view-model: viewport dimensions must be non-negative');
  }
}

function validatePoint(point: Point, name: string): void {
  finite(point.x, `${name}.x`);
  finite(point.y, `${name}.y`);
}

/** Construct a validated immutable camera value. */
export function createCameraState(center: Point = { x: 0, y: 0 }, scale = 1): CameraState {
  const camera = { center: { x: center.x, y: center.y }, scale };
  validateCamera(camera);
  return camera;
}

/** World → CSS-screen scale+translate (ADR-0015 y-down means no axis flip). */
export function worldToScreen(point: Point, camera: CameraState, viewport: ViewportSize): Point {
  validatePoint(point, 'world point');
  validateCamera(camera);
  validateViewport(viewport);
  return {
    x: (point.x - camera.center.x) * camera.scale + viewport.width / 2,
    y: (point.y - camera.center.y) * camera.scale + viewport.height / 2,
  };
}

/** CSS-screen → world; the exact inverse of {@link worldToScreen}. */
export function screenToWorld(point: Point, camera: CameraState, viewport: ViewportSize): Point {
  validatePoint(point, 'screen point');
  validateCamera(camera);
  validateViewport(viewport);
  return {
    x: camera.center.x + (point.x - viewport.width / 2) / camera.scale,
    y: camera.center.y + (point.y - viewport.height / 2) / camera.scale,
  };
}

/**
 * Pan by a CSS-pixel drag delta. Positive x/y makes content follow the drag,
 * so the world center moves in the opposite direction.
 */
export function panBy(camera: CameraState, screenDelta: Point): CameraState {
  validateCamera(camera);
  validatePoint(screenDelta, 'pan delta');
  return {
    center: {
      x: camera.center.x - screenDelta.x / camera.scale,
      y: camera.center.y - screenDelta.y / camera.scale,
    },
    scale: camera.scale,
  };
}

/** Zoom geometrically while preserving the world point under `screenAnchor`. */
export function zoomAt(
  camera: CameraState,
  screenAnchor: Point,
  factor: number,
  viewport: ViewportSize,
  limits: CameraScaleLimits = DEFAULT_CAMERA_SCALE_LIMITS,
): CameraState {
  validateCamera(camera);
  validatePoint(screenAnchor, 'zoom anchor');
  validateViewport(viewport);
  finite(factor, 'zoom factor');
  finite(limits.min, 'scale limit min');
  finite(limits.max, 'scale limit max');
  if (factor <= 0) throw new RangeError('view-model: zoom factor must be greater than zero');
  if (limits.min <= 0 || limits.max < limits.min) {
    throw new RangeError('view-model: camera scale limits must satisfy 0 < min <= max');
  }

  const anchorWorld = screenToWorld(screenAnchor, camera, viewport);
  const requested = camera.scale * factor;
  const scale = Math.min(limits.max, Math.max(limits.min, requested));
  return {
    center: {
      x: anchorWorld.x - (screenAnchor.x - viewport.width / 2) / scale,
      y: anchorWorld.y - (screenAnchor.y - viewport.height / 2) / scale,
    },
    scale,
  };
}
