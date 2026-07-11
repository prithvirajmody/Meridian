/**
 * ADR-0021 pure synchronous hit-test over the world-space spatial index.
 *
 * Tolerances are CSS pixels converted to world units at query time; DPR never
 * enters. No worker/DOM/Pixi import, so boundary and hi-DPI cases are testable
 * headless. Nodes always beat edges near endpoints; ties resolve by the shared
 * `visualLayer` comparator (hover > selected > greater model index).
 */
import {
  screenToWorld,
  worldToScreen,
  type CameraState,
  type NodeId,
  type Point,
  type RenderModel,
  type ViewportSize,
} from '@meridian/view-model';
import { queryQuadtree, type Aabb, type PackedQuadtree } from '../quadtree.js';
import type { EdgeSegmentStore } from '../scene-plan.js';
import { visualLayer } from '../visual-order.js';

/** Node hit half-width, in CSS pixels. */
export const NODE_PICK_TOLERANCE_CSS_PX = 2;
/** Edge hit distance tolerance, inclusive, in CSS pixels. */
export const EDGE_PICK_TOLERANCE_CSS_PX = 4;
/** Minimum pickable footprint of a zero-size node, in CSS pixels (ADR-0015). */
export const ZERO_SIZE_MARKER_CSS_PX = 6;

export type HitTestResult =
  | {
      readonly kind: 'node';
      readonly nodeIndex: number;
      readonly nodeId: NodeId;
      readonly screen: Point;
      readonly world: Point;
    }
  | {
      readonly kind: 'edge';
      readonly edgeIndex: number;
      readonly edgeKey: string;
      readonly screen: Point;
      readonly world: Point;
    };

export interface HitTestInput {
  readonly model: RenderModel;
  readonly nodeTree: PackedQuadtree;
  readonly edgeTree: PackedQuadtree;
  readonly edgeSegments: EdgeSegmentStore;
  readonly camera: CameraState;
  readonly viewport: ViewportSize;
  /** Canvas-local CSS-pixel pointer position. */
  readonly screen: Point;
  /** Current hover node index for the topmost-winner tie-break, or `null`. */
  readonly hoverNodeIndex: number | null;
}

function toleranceBox(world: Point, halfWidth: number): Aabb {
  return {
    minX: world.x - halfWidth,
    minY: world.y - halfWidth,
    maxX: world.x + halfWidth,
    maxY: world.y + halfWidth,
  };
}

/** Exact CSS-pixel screen box the node is drawn into. */
function nodeScreenBox(
  model: RenderModel,
  index: number,
  camera: CameraState,
  viewport: ViewportSize,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const lane = index * 4;
  const x = model.nodeRects[lane]!;
  const y = model.nodeRects[lane + 1]!;
  const width = model.nodeRects[lane + 2]!;
  const height = model.nodeRects[lane + 3]!;
  if (width === 0 && height === 0) {
    const center = worldToScreen({ x, y }, camera, viewport);
    const half = ZERO_SIZE_MARKER_CSS_PX / 2;
    return { minX: center.x - half, minY: center.y - half, maxX: center.x + half, maxY: center.y + half };
  }
  const min = worldToScreen({ x, y }, camera, viewport);
  const max = worldToScreen({ x: x + width, y: y + height }, camera, viewport);
  return {
    minX: Math.min(min.x, max.x),
    minY: Math.min(min.y, max.y),
    maxX: Math.max(min.x, max.x),
    maxY: Math.max(min.y, max.y),
  };
}

function withinClosed(box: { minX: number; minY: number; maxX: number; maxY: number }, point: Point): boolean {
  return point.x >= box.minX && point.x <= box.maxX && point.y >= box.minY && point.y <= box.maxY;
}

/** Squared distance from `point` to segment `a→b`, all in screen space. */
function pointToSegmentDistance(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return Math.hypot(point.x - projX, point.y - projY);
}

function pickNode(input: HitTestInput, world: Point): HitTestResult | null {
  // ADR-0021 specifies a 2-CSS-px broad-phase half-width, but a zero-size node is
  // drawn/picked as a 6-CSS-px marker (3-px half-extent). A bare 2-px query would
  // prune marker-edge hits, so the broad phase reaches the greater of the two.
  // Exact screen containment below still adds no tolerance to real node rects.
  const halfWidthCssPx = Math.max(NODE_PICK_TOLERANCE_CSS_PX, ZERO_SIZE_MARKER_CSS_PX / 2);
  const halfWidth = halfWidthCssPx / input.camera.scale;
  const candidates = queryQuadtree(input.nodeTree, toleranceBox(world, halfWidth));
  let bestIndex = -1;
  let bestLayer = -1;
  for (const index of candidates) {
    const box = nodeScreenBox(input.model, index, input.camera, input.viewport);
    if (!withinClosed(box, input.screen)) continue;
    const layer = visualLayer(input.model, index, input.hoverNodeIndex);
    // Topmost wins: higher layer, else greater model index.
    if (layer > bestLayer || (layer === bestLayer && index > bestIndex)) {
      bestIndex = index;
      bestLayer = layer;
    }
  }
  if (bestIndex === -1) return null;
  return {
    kind: 'node',
    nodeIndex: bestIndex,
    nodeId: input.model.nodeIds[bestIndex]!,
    screen: input.screen,
    world,
  };
}

function pickEdge(input: HitTestInput, world: Point): HitTestResult | null {
  const halfWidth = EDGE_PICK_TOLERANCE_CSS_PX / input.camera.scale;
  const candidates = queryQuadtree(input.edgeTree, toleranceBox(world, halfWidth));
  let bestEdgeIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const segmentIndex of candidates) {
    const lane = segmentIndex * 4;
    const a = worldToScreen(
      { x: input.edgeSegments.coordinates[lane]!, y: input.edgeSegments.coordinates[lane + 1]! },
      input.camera,
      input.viewport,
    );
    const b = worldToScreen(
      { x: input.edgeSegments.coordinates[lane + 2]!, y: input.edgeSegments.coordinates[lane + 3]! },
      input.camera,
      input.viewport,
    );
    const distance = pointToSegmentDistance(input.screen, a, b);
    if (distance > EDGE_PICK_TOLERANCE_CSS_PX) continue;
    const edgeIndex = input.edgeSegments.edgeIndices[segmentIndex]!;
    // Minimum distance wins; ties resolve to the greater rendered edge index.
    if (distance < bestDistance || (distance === bestDistance && edgeIndex > bestEdgeIndex)) {
      bestDistance = distance;
      bestEdgeIndex = edgeIndex;
    }
  }
  if (bestEdgeIndex === -1) return null;
  return {
    kind: 'edge',
    edgeIndex: bestEdgeIndex,
    edgeKey: input.model.edgeKeys[bestEdgeIndex]!,
    screen: input.screen,
    world,
  };
}

/** Synchronous pick: node first, edge only if no node wins (ADR-0021). */
export function hitTest(input: HitTestInput): HitTestResult | null {
  const world = screenToWorld(input.screen, input.camera, input.viewport);
  return pickNode(input, world) ?? pickEdge(input, world);
}
