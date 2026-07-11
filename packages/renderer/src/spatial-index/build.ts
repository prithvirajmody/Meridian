/** Pure worker-side construction for ADR-0021. No DOM, worker, Pixi, or layout imports. */
import { buildQuadtree, type QuadtreeItem } from '../quadtree.js';
import type {
  SpatialIndexBuildRequest,
  SpatialIndexBuildResponse,
} from './protocol.js';

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`renderer: ${name} must be finite`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function laneCount(values: Float64Array, name: string): number {
  if (values.length % 4 !== 0) {
    throw new RangeError(`renderer: ${name} must contain complete four-lane records`);
  }
  return values.length / 4;
}

function nodeItems(rects: Float64Array): QuadtreeItem[] {
  const count = laneCount(rects, 'spatial-index nodeRects');
  const result: QuadtreeItem[] = [];
  for (let index = 0; index < count; index++) {
    const lane = index * 4;
    const x = finite(rects[lane]!, `spatial-index node ${index} x`);
    const y = finite(rects[lane + 1]!, `spatial-index node ${index} y`);
    const width = finite(rects[lane + 2]!, `spatial-index node ${index} width`);
    const height = finite(rects[lane + 3]!, `spatial-index node ${index} height`);
    if (width < 0 || height < 0) {
      throw new RangeError(
        `renderer: spatial-index node ${index} dimensions must be non-negative`,
      );
    }
    const maxX = finite(x + width, `spatial-index node ${index} maxX`);
    const maxY = finite(y + height, `spatial-index node ${index} maxY`);
    result.push({ index, bounds: { minX: x, minY: y, maxX, maxY } });
  }
  return result;
}

function edgeItems(segments: Float64Array): QuadtreeItem[] {
  const count = laneCount(segments, 'spatial-index edgeSegments');
  const result: QuadtreeItem[] = [];
  for (let index = 0; index < count; index++) {
    const lane = index * 4;
    const x1 = finite(segments[lane]!, `spatial-index edge segment ${index} x1`);
    const y1 = finite(segments[lane + 1]!, `spatial-index edge segment ${index} y1`);
    const x2 = finite(segments[lane + 2]!, `spatial-index edge segment ${index} x2`);
    const y2 = finite(segments[lane + 3]!, `spatial-index edge segment ${index} y2`);
    result.push({
      index,
      bounds: {
        minX: Math.min(x1, x2),
        minY: Math.min(y1, y2),
        maxX: Math.max(x1, x2),
        maxY: Math.max(y1, y2),
      },
    });
  }
  return result;
}

/** Build both canonical packed trees for one immutable model revision. */
export function buildSpatialIndex(
  request: SpatialIndexBuildRequest,
): SpatialIndexBuildResponse {
  return {
    type: 'built',
    requestId: request.requestId,
    modelRevision: request.modelRevision,
    nodeTree: buildQuadtree(nodeItems(request.nodeRects)),
    edgeTree: buildQuadtree(edgeItems(request.edgeSegments)),
  };
}
