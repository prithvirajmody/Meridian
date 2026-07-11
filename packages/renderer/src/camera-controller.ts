import {
  DEFAULT_CAMERA_SCALE_LIMITS,
  createCameraState,
  panBy as panCameraBy,
  zoomAt as zoomCameraAt,
} from '@meridian/view-model';
import type {
  CameraScaleLimits,
  CameraState,
  Point,
  Rect,
  ViewportSize,
} from '@meridian/view-model';
import type { Unsubscribe } from './types.js';

export interface CameraViewport extends ViewportSize {
  /** Backing-store pixels per CSS pixel. It never enters camera geometry. */
  readonly devicePixelRatio: number;
}

export interface FitToBoundsOptions {
  /** Inset on every side of the viewport, measured in CSS pixels. */
  readonly padding?: number;
}

export interface CameraControllerOptions {
  readonly initialState?: CameraState;
  readonly viewport?: ViewportSize;
  readonly devicePixelRatio?: number;
  readonly scaleLimits?: CameraScaleLimits;
}

export interface CameraController {
  state(): CameraState;
  viewport(): CameraViewport;
  panBy(delta: Point): void;
  zoomAt(screen: Point, factor: number): void;
  fitToBounds(bounds: Rect | null, options?: FitToBoundsOptions): void;
  resize(viewport: ViewportSize, devicePixelRatio?: number): void;
  on(event: 'change', listener: (state: CameraState) => void): Unsubscribe;
  destroy(): void;
}

function finite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`renderer: ${name} must be finite`);
  }
}

function validateViewport(viewport: ViewportSize): void {
  finite(viewport.width, 'viewport.width');
  finite(viewport.height, 'viewport.height');
  if (viewport.width < 0 || viewport.height < 0) {
    throw new RangeError('renderer: viewport dimensions must be non-negative');
  }
}

function validateDevicePixelRatio(devicePixelRatio: number): void {
  finite(devicePixelRatio, 'devicePixelRatio');
  if (devicePixelRatio <= 0) {
    throw new RangeError('renderer: devicePixelRatio must be greater than zero');
  }
}

function validateLimits(limits: CameraScaleLimits): void {
  finite(limits.min, 'scaleLimits.min');
  finite(limits.max, 'scaleLimits.max');
  if (limits.min <= 0 || limits.max < limits.min) {
    throw new RangeError('renderer: scale limits must satisfy 0 < min <= max');
  }
}

function validateBounds(bounds: Rect): void {
  finite(bounds.x, 'bounds.x');
  finite(bounds.y, 'bounds.y');
  finite(bounds.width, 'bounds.width');
  finite(bounds.height, 'bounds.height');
  if (bounds.width < 0 || bounds.height < 0) {
    throw new RangeError('renderer: bounds dimensions must be non-negative');
  }
}

function sameState(left: CameraState, right: CameraState): boolean {
  return (
    left.center.x === right.center.x &&
    left.center.y === right.center.y &&
    left.scale === right.scale
  );
}

function copyState(state: CameraState): CameraState {
  return { center: { x: state.center.x, y: state.center.y }, scale: state.scale };
}

/**
 * Pure framing math. `null` means an empty scene and is deliberately a no-op.
 * A point-sized bounds is centered without inventing an arbitrary zoom level.
 */
export function fitCameraToBounds(
  camera: CameraState,
  bounds: Rect | null,
  viewport: ViewportSize,
  limits: CameraScaleLimits = DEFAULT_CAMERA_SCALE_LIMITS,
  options: FitToBoundsOptions = {},
): CameraState {
  const validatedCamera = createCameraState(camera.center, camera.scale);
  validateViewport(viewport);
  validateLimits(limits);
  if (bounds === null) return validatedCamera;
  validateBounds(bounds);

  const padding = options.padding ?? 32;
  finite(padding, 'fit padding');
  if (padding < 0) {
    throw new RangeError('renderer: fit padding must be non-negative');
  }

  const availableWidth = Math.max(0, viewport.width - padding * 2);
  const availableHeight = Math.max(0, viewport.height - padding * 2);
  const candidates: number[] = [];
  if (bounds.width > 0 && availableWidth > 0) {
    candidates.push(availableWidth / bounds.width);
  }
  if (bounds.height > 0 && availableHeight > 0) {
    candidates.push(availableHeight / bounds.height);
  }

  const requestedScale = candidates.length > 0 ? Math.min(...candidates) : camera.scale;
  const scale = Math.min(limits.max, Math.max(limits.min, requestedScale));
  return createCameraState(
    {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    },
    scale,
  );
}

/** Geometric camera owner. Semantic zoom and animation remain Phase 6 concerns. */
export class GeometricCameraController implements CameraController {
  private current: CameraState;
  private currentViewport: CameraViewport;
  private readonly limits: CameraScaleLimits;
  private readonly listeners = new Set<(state: CameraState) => void>();
  private destroyed = false;

  constructor(options: CameraControllerOptions = {}) {
    const initial = options.initialState ?? createCameraState();
    this.current = createCameraState(initial.center, initial.scale);

    const viewport = options.viewport ?? { width: 0, height: 0 };
    const devicePixelRatio = options.devicePixelRatio ?? 1;
    validateViewport(viewport);
    validateDevicePixelRatio(devicePixelRatio);
    this.currentViewport = { ...viewport, devicePixelRatio };

    const limits = options.scaleLimits ?? DEFAULT_CAMERA_SCALE_LIMITS;
    validateLimits(limits);
    this.limits = { min: limits.min, max: limits.max };
    if (this.current.scale < this.limits.min || this.current.scale > this.limits.max) {
      this.current = createCameraState(
        this.current.center,
        Math.min(this.limits.max, Math.max(this.limits.min, this.current.scale)),
      );
    }
  }

  state(): CameraState {
    return copyState(this.current);
  }

  viewport(): CameraViewport {
    return { ...this.currentViewport };
  }

  panBy(delta: Point): void {
    this.assertAlive();
    this.setState(panCameraBy(this.current, delta));
  }

  zoomAt(screen: Point, factor: number): void {
    this.assertAlive();
    this.setState(
      zoomCameraAt(this.current, screen, factor, this.currentViewport, this.limits),
    );
  }

  fitToBounds(bounds: Rect | null, options: FitToBoundsOptions = {}): void {
    this.assertAlive();
    this.setState(
      fitCameraToBounds(this.current, bounds, this.currentViewport, this.limits, options),
    );
  }

  resize(viewport: ViewportSize, devicePixelRatio = this.currentViewport.devicePixelRatio): void {
    this.assertAlive();
    validateViewport(viewport);
    validateDevicePixelRatio(devicePixelRatio);
    const changed =
      viewport.width !== this.currentViewport.width ||
      viewport.height !== this.currentViewport.height ||
      devicePixelRatio !== this.currentViewport.devicePixelRatio;
    this.currentViewport = { ...viewport, devicePixelRatio };
    // A viewport-only change still invalidates the world-to-screen transform.
    if (changed) this.emit();
  }

  on(event: 'change', listener: (state: CameraState) => void): Unsubscribe {
    this.assertAlive();
    if (event !== 'change') {
      throw new RangeError(`renderer: unsupported camera event ${String(event)}`);
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.listeners.clear();
  }

  private setState(next: CameraState): void {
    if (sameState(this.current, next)) return;
    this.current = copyState(next);
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener(copyState(this.current));
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error('renderer: camera controller is destroyed');
  }
}

export function createCameraController(options: CameraControllerOptions = {}): CameraController {
  return new GeometricCameraController(options);
}
