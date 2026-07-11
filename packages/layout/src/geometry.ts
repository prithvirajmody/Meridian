/**
 * World-space geometry helpers (ADR-0015) and the deterministic
 * disconnected-component shelf-packer shared by the `grid` and `tree`
 * providers. Value functions only — the pure type layer lives in `coords.ts`.
 *
 * Packing (ADR-0015): each connected component is laid out in its own local
 * frame, then the component AABBs are packed into the shared world plane by a
 * deterministic shelf/row packer — components ordered by **descending area,
 * ties by ascending minimum member `NodeId`**, gap `hints.spacing` between
 * AABBs — so components never overlap and identical input yields byte-identical
 * placement (I6).
 */
import type { NodeId } from '@meridian/graph-core';
import type { Point, Rect } from './coords.js';

/** The empty-cut / empty-set bounds (ADR-0015). */
export const EMPTY_BOUNDS: Rect = { x: 0, y: 0, width: 0, height: 0 };

/** Default world-unit gap when `hints.spacing` is unset — used both between
 * boxes within a provider and between packed components. */
export const DEFAULT_SPACING = 24;

/** Center of a `Rect` (ADR-0015: `(x + w/2, y + h/2)`). */
export function centerOf(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** Tight AABB enclosing every rect and every extra point (ADR-0015 `bounds`
 * semantics). Empty input → `{0,0,0,0}`. */
export function boundsOf(rects: Iterable<Rect>, points: Iterable<Point> = []): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let saw = false;
  for (const r of rects) {
    saw = true;
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.width > maxX) maxX = r.x + r.width;
    if (r.y + r.height > maxY) maxY = r.y + r.height;
  }
  for (const p of points) {
    saw = true;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!saw) return EMPTY_BOUNDS;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function compareIds(a: NodeId, b: NodeId): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** One component laid out in its own local frame: a placement per member. */
export interface LaidOutComponent {
  /** Member → local-frame `Rect`. */
  readonly local: ReadonlyMap<NodeId, Rect>;
  /** Ascending-sorted members (its minimum member is `members[0]`). */
  readonly members: readonly NodeId[];
}

interface PlacedComponent {
  readonly comp: LaidOutComponent;
  readonly aabb: Rect;
  readonly area: number;
  readonly minId: NodeId;
}

/**
 * Pack the laid-out components into one world-space placement map (ADR-0015).
 * Each component is normalized to its local min-corner, then shelf-packed:
 * components in **descending-area, ascending-minId** order fill rows up to a
 * deterministic width limit (`max(widest component, √Σarea)`), wrapping to a
 * new shelf whose height is the tallest box on the previous shelf; the gap
 * between adjacent AABBs — within a shelf and between shelves — is `spacing`.
 * At least one component sits on every shelf (a lone over-wide component still
 * places). Returns the merged positions in ascending-`NodeId` order.
 */
export function packComponents(
  components: readonly LaidOutComponent[],
  spacing: number,
): Map<NodeId, Rect> {
  const placed: PlacedComponent[] = components
    .filter((c) => c.members.length > 0)
    .map((comp) => {
      const aabb = boundsOf(comp.local.values());
      return { comp, aabb, area: aabb.width * aabb.height, minId: comp.members[0]! };
    });
  // Descending area, ties ascending minimum member (ADR-0015).
  placed.sort((a, b) => b.area - a.area || compareIds(a.minId, b.minId));

  const totalArea = placed.reduce((s, p) => s + p.area, 0);
  const maxWidth = placed.reduce((m, p) => Math.max(m, p.aabb.width), 0);
  const limit = Math.max(maxWidth, Math.sqrt(totalArea));

  const out = new Map<NodeId, Rect>();
  let cursorX = 0;
  let shelfY = 0;
  let shelfHeight = 0;
  let onShelf = 0;

  for (const p of placed) {
    const w = p.aabb.width;
    const h = p.aabb.height;
    if (onShelf > 0 && cursorX + spacing + w > limit) {
      // Wrap to a new shelf below the tallest box of the current one.
      shelfY += shelfHeight + spacing;
      cursorX = 0;
      shelfHeight = 0;
      onShelf = 0;
    }
    const offsetX = (onShelf > 0 ? cursorX + spacing : 0) - p.aabb.x;
    const offsetY = shelfY - p.aabb.y;
    for (const m of p.comp.members) {
      const r = p.comp.local.get(m)!;
      out.set(m, { x: r.x + offsetX, y: r.y + offsetY, width: r.width, height: r.height });
    }
    cursorX = (onShelf > 0 ? cursorX + spacing : 0) + w;
    shelfHeight = Math.max(shelfHeight, h);
    onShelf++;
  }

  // Re-key in ascending NodeId order for a stable positions map (I6).
  const ordered = [...out.keys()].sort(compareIds);
  const sorted = new Map<NodeId, Rect>();
  for (const id of ordered) sorted.set(id, out.get(id)!);
  return sorted;
}
