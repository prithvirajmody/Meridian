/**
 * World-space geometry (ADR-0015). Three plain, immutable,
 * presentation-neutral records: the coordinate vocabulary every layout
 * provider emits and every downstream consumer (SVG exporter here; renderer &
 * view-model in P5) reads.
 *
 * The space is **world space**: a plane with **y increasing downward** (screen
 * convention, so the renderer's world→screen map is a pure scale+translate),
 * coordinates are IEEE **float64**, and units are **abstract** — never pixels
 * (ADR-0015). `Rect.(x, y)` is the **minimum corner** (visual top-left, since y
 * grows downward); a box spans `[x, x+width] × [y, y+height]`.
 *
 * Dependency law (ADR-0015 ruling): this module has **zero intra-layout
 * imports of layout logic** and imports nothing at all — it is a pure type
 * layer that lifts into `@meridian/view-model` unchanged at subphase 5B.
 */

/** A world-space point (y-down). Every coordinate is finite (ADR-0015). */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A world-space extent. Both dimensions are `≥ 0`; `{0,0}` is a legal
 * (degenerate) size for a zero-size node (ADR-0015). */
export interface Size {
  readonly width: number;
  readonly height: number;
}

/** An axis-aligned box given by its **minimum corner** `(x, y)` (top-left,
 * y-down) and non-negative extent. Its center is
 * `(x + width/2, y + height/2)`. A zero-size node is the degenerate point-rect
 * `{ x, y, width: 0, height: 0 }` (ADR-0015). */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
