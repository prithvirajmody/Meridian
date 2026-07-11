/**
 * World-space geometry (ADR-0015), moved from `@meridian/layout` at subphase
 * 5B per ADR-0022. Coordinates are finite float64 values in an abstract,
 * y-down plane. Pixels exist only in camera/renderer code.
 */

/** A world-space point (y-down). */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A non-negative world-space extent. */
export interface Size {
  readonly width: number;
  readonly height: number;
}

/** A min-corner world-space box: `(x,y)` is top-left in the y-down plane. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
