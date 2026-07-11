/**
 * Pure spatial planning for the Pixi scene boundary (ROADMAP Phase 5 §3–4).
 *
 * Model primitives keep their original indices while deterministic Morton
 * ordering gives each spatial upload batch locality. Culling is expressed only
 * in world-space AABBs; this module has no DOM, canvas, or Pixi dependency.
 */
import type { CameraState, RenderModel, ViewportSize } from '@meridian/view-model';
import {
  buildQuadtree,
  queryQuadtreeWithStats,
  type Aabb,
  type PackedQuadtree,
  type QuadtreeItem,
} from './quadtree.js';

export const DEFAULT_SPATIAL_BATCH_SIZE = 512;
/** ADR-0021 viewport prefetch band, measured in CSS pixels. */
export const CULL_PREFETCH_MARGIN_CSS_PX = 64;

export interface ScenePlanOptions {
  /** Primitive count per draw batch. ADR-0019 caps this at 512. */
  readonly maxBatchSize?: number;
}

/** Packed straight segments: `[x1,y1,x2,y2]` and owning model-edge index. */
export interface EdgeSegmentStore {
  readonly coordinates: Float64Array;
  readonly edgeIndices: Uint32Array;
}

/** Static spatial upload group. Primitive indices are in Morton order. */
export interface SpatialBatch {
  readonly bounds: Aabb;
  readonly primitiveIndices: Uint32Array;
}

/** Visible subset of one static upload group. */
export interface VisibleSpatialBatch {
  readonly batchIndex: number;
  readonly indices: Uint32Array;
}

export interface SceneGeometryPlan {
  readonly modelRevision: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly edgeSegments: EdgeSegmentStore;
  readonly nodeBatches: readonly SpatialBatch[];
  readonly edgeBatches: readonly SpatialBatch[];
  /** Batch index by original model-node index. */
  readonly nodeBatchByPrimitive: Uint32Array;
  /** Batch index by packed edge-segment index. */
  readonly edgeBatchByPrimitive: Uint32Array;
}

export interface ScenePlan extends SceneGeometryPlan {
  readonly nodeTree: PackedQuadtree;
  readonly edgeTree: PackedQuadtree;
}

export interface SceneSpatialIndex {
  readonly modelRevision: string;
  readonly nodeTree: PackedQuadtree;
  readonly edgeTree: PackedQuadtree;
}

export interface SceneCullStats {
  readonly modelNodes: number;
  readonly candidateNodes: number;
  readonly visibleNodes: number;
  readonly culledNodes: number;
  readonly modelEdges: number;
  readonly visibleEdges: number;
  readonly culledEdges: number;
  readonly modelEdgeSegments: number;
  readonly candidateEdgeSegments: number;
  readonly visibleEdgeSegments: number;
  readonly submittedNodeBatches: number;
  readonly submittedEdgeBatches: number;
  /** One draw per non-empty visible node or segment batch. */
  readonly drawCalls: number;
}

export interface CulledScene {
  readonly viewportBounds: Aabb;
  readonly nodeBatches: readonly VisibleSpatialBatch[];
  readonly edgeBatches: readonly VisibleSpatialBatch[];
  readonly stats: SceneCullStats;
}

interface SpatialPrimitive {
  readonly index: number;
  readonly bounds: Aabb;
  readonly centerX: number;
  readonly centerY: number;
}

interface BatchResult {
  readonly batches: readonly SpatialBatch[];
  readonly batchByPrimitive: Uint32Array;
}

function validateBatchSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_SPATIAL_BATCH_SIZE) {
    throw new RangeError(
      `renderer: maxBatchSize must be a safe integer between 1 and ${DEFAULT_SPATIAL_BATCH_SIZE}`,
    );
  }
  return value;
}

function validateFinite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`renderer: ${name} must be finite`);
  return Object.is(value, -0) ? 0 : value;
}

function nodePrimitives(model: RenderModel): SpatialPrimitive[] {
  const result: SpatialPrimitive[] = [];
  for (let index = 0; index < model.nodeIds.length; index++) {
    const lane = index * 4;
    const x = validateFinite(model.nodeRects[lane]!, `node ${index} x`);
    const y = validateFinite(model.nodeRects[lane + 1]!, `node ${index} y`);
    const width = validateFinite(model.nodeRects[lane + 2]!, `node ${index} width`);
    const height = validateFinite(model.nodeRects[lane + 3]!, `node ${index} height`);
    if (width < 0 || height < 0) {
      throw new RangeError(`renderer: node ${index} dimensions must be non-negative`);
    }
    const maxX = x + width;
    const maxY = y + height;
    result.push({
      index,
      bounds: { minX: x, minY: y, maxX, maxY },
      centerX: x + width / 2,
      centerY: y + height / 2,
    });
  }
  return result;
}

function nodeCenter(model: RenderModel, index: number): readonly [number, number] {
  if (!Number.isSafeInteger(index) || index < 0 || index >= model.nodeIds.length) {
    throw new RangeError(`renderer: edge endpoint node index ${index} is out of range`);
  }
  const lane = index * 4;
  return [
    model.nodeRects[lane]! + model.nodeRects[lane + 2]! / 2,
    model.nodeRects[lane + 1]! + model.nodeRects[lane + 3]! / 2,
  ];
}

function appendSegment(
  coordinates: number[],
  edgeIndices: number[],
  edgeIndex: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): void {
  coordinates.push(x1, y1, x2, y2);
  edgeIndices.push(edgeIndex);
}

function buildEdgeSegments(model: RenderModel): EdgeSegmentStore {
  const edgeCount = model.edgeKeys.length;
  if (model.edgeRouteOffsets.length !== edgeCount + 1) {
    throw new RangeError('renderer: edge route offsets must contain one entry per edge plus one');
  }

  const coordinates: number[] = [];
  const edgeIndices: number[] = [];
  const pointCount = model.edgeRoutePoints.length / 2;
  for (let edgeIndex = 0; edgeIndex < edgeCount; edgeIndex++) {
    const routeStart = model.edgeRouteOffsets[edgeIndex]!;
    const routeEnd = model.edgeRouteOffsets[edgeIndex + 1]!;
    if (routeStart > routeEnd || routeEnd > pointCount) {
      throw new RangeError(`renderer: edge ${edgeIndex} route offsets are out of range`);
    }

    if (routeStart === routeEnd) {
      const sourceIndex = model.edgeIndices[edgeIndex * 2]!;
      const targetIndex = model.edgeIndices[edgeIndex * 2 + 1]!;
      const [x1, y1] = nodeCenter(model, sourceIndex);
      const [x2, y2] = nodeCenter(model, targetIndex);
      appendSegment(coordinates, edgeIndices, edgeIndex, x1, y1, x2, y2);
      continue;
    }

    for (let point = routeStart; point + 1 < routeEnd; point++) {
      const firstLane = point * 2;
      const secondLane = (point + 1) * 2;
      appendSegment(
        coordinates,
        edgeIndices,
        edgeIndex,
        validateFinite(model.edgeRoutePoints[firstLane]!, `edge ${edgeIndex} route x`),
        validateFinite(model.edgeRoutePoints[firstLane + 1]!, `edge ${edgeIndex} route y`),
        validateFinite(model.edgeRoutePoints[secondLane]!, `edge ${edgeIndex} route x`),
        validateFinite(model.edgeRoutePoints[secondLane + 1]!, `edge ${edgeIndex} route y`),
      );
    }
  }

  return {
    coordinates: Float64Array.from(coordinates),
    edgeIndices: Uint32Array.from(edgeIndices),
  };
}

function edgePrimitives(segments: EdgeSegmentStore): SpatialPrimitive[] {
  const result: SpatialPrimitive[] = [];
  for (let index = 0; index < segments.edgeIndices.length; index++) {
    const lane = index * 4;
    const x1 = segments.coordinates[lane]!;
    const y1 = segments.coordinates[lane + 1]!;
    const x2 = segments.coordinates[lane + 2]!;
    const y2 = segments.coordinates[lane + 3]!;
    result.push({
      index,
      bounds: {
        minX: Math.min(x1, x2),
        minY: Math.min(y1, y2),
        maxX: Math.max(x1, x2),
        maxY: Math.max(y1, y2),
      },
      centerX: x1 + (x2 - x1) / 2,
      centerY: y1 + (y2 - y1) / 2,
    });
  }
  return result;
}

/** Spread 16 input bits over the even bits of a uint32. */
function spreadBits(value: number): number {
  let result = value & 0xffff;
  result = (result | (result << 8)) & 0x00ff00ff;
  result = (result | (result << 4)) & 0x0f0f0f0f;
  result = (result | (result << 2)) & 0x33333333;
  result = (result | (result << 1)) & 0x55555555;
  return result >>> 0;
}

function quantize(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  const normalized = (value - min) / (max - min);
  return Math.max(0, Math.min(0xffff, Math.round(normalized * 0xffff)));
}

function mortonCode(
  primitive: SpatialPrimitive,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): number {
  const x = spreadBits(quantize(primitive.centerX, minX, maxX));
  const y = spreadBits(quantize(primitive.centerY, minY, maxY));
  return (x | (y << 1)) >>> 0;
}

function enclosingBatchBounds(primitives: readonly SpatialPrimitive[]): Aabb {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const primitive of primitives) {
    minX = Math.min(minX, primitive.bounds.minX);
    minY = Math.min(minY, primitive.bounds.minY);
    maxX = Math.max(maxX, primitive.bounds.maxX);
    maxY = Math.max(maxY, primitive.bounds.maxY);
  }
  return { minX, minY, maxX, maxY };
}

function buildSpatialBatches(
  input: readonly SpatialPrimitive[],
  maxBatchSize: number,
): BatchResult {
  if (input.length === 0) {
    return { batches: [], batchByPrimitive: new Uint32Array() };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const primitive of input) {
    minX = Math.min(minX, primitive.centerX);
    minY = Math.min(minY, primitive.centerY);
    maxX = Math.max(maxX, primitive.centerX);
    maxY = Math.max(maxY, primitive.centerY);
  }

  const ordered = input
    .map((primitive) => ({
      primitive,
      morton: mortonCode(primitive, minX, minY, maxX, maxY),
    }))
    .sort((left, right) => left.morton - right.morton || left.primitive.index - right.primitive.index)
    .map(({ primitive }) => primitive);

  const batches: SpatialBatch[] = [];
  const batchByPrimitive = new Uint32Array(input.length);
  for (let start = 0; start < ordered.length; start += maxBatchSize) {
    const members = ordered.slice(start, start + maxBatchSize);
    const batchIndex = batches.length;
    const primitiveIndices = Uint32Array.from(members.map(({ index }) => index));
    for (const primitive of members) batchByPrimitive[primitive.index] = batchIndex;
    batches.push({ bounds: enclosingBatchBounds(members), primitiveIndices });
  }
  return { batches, batchByPrimitive };
}

/** Build draw batches without constructing the off-main spatial index. */
export function buildSceneGeometryPlan(
  model: RenderModel,
  options: ScenePlanOptions = {},
): SceneGeometryPlan {
  const maxBatchSize = validateBatchSize(options.maxBatchSize ?? DEFAULT_SPATIAL_BATCH_SIZE);
  const nodes = nodePrimitives(model);
  const edgeSegments = buildEdgeSegments(model);
  const edges = edgePrimitives(edgeSegments);
  const nodeBatchResult = buildSpatialBatches(nodes, maxBatchSize);
  const edgeBatchResult = buildSpatialBatches(edges, maxBatchSize);

  return {
    modelRevision: model.revision,
    nodeCount: model.nodeIds.length,
    edgeCount: model.edgeKeys.length,
    edgeSegments,
    nodeBatches: nodeBatchResult.batches,
    edgeBatches: edgeBatchResult.batches,
    nodeBatchByPrimitive: nodeBatchResult.batchByPrimitive,
    edgeBatchByPrimitive: edgeBatchResult.batchByPrimitive,
  };
}

/** Attach worker-built trees to immutable draw geometry. */
export function completeScenePlan(
  geometry: SceneGeometryPlan,
  index: SceneSpatialIndex,
): ScenePlan {
  if (index.modelRevision !== geometry.modelRevision) {
    throw new Error(
      `renderer: spatial index revision ${index.modelRevision} does not match scene ${geometry.modelRevision}`,
    );
  }
  return { ...geometry, nodeTree: index.nodeTree, edgeTree: index.edgeTree };
}

/**
 * Headless convenience used by pure tests and non-browser tools. The Pixi
 * adapter uses `buildSceneGeometryPlan` plus the ADR-0021 worker host instead.
 */
export function buildScenePlan(
  model: RenderModel,
  options: ScenePlanOptions = {},
): ScenePlan {
  const geometry = buildSceneGeometryPlan(model, options);
  const nodes = nodePrimitives(model);
  const edges = edgePrimitives(geometry.edgeSegments);
  const nodeItems: QuadtreeItem[] = nodes.map(({ index, bounds }) => ({ index, bounds }));
  const edgeItems: QuadtreeItem[] = edges.map(({ index, bounds }) => ({ index, bounds }));
  return completeScenePlan(geometry, {
    modelRevision: geometry.modelRevision,
    nodeTree: buildQuadtree(nodeItems),
    edgeTree: buildQuadtree(edgeItems),
  });
}

function viewportBounds(camera: CameraState, viewport: ViewportSize): Aabb {
  const centerX = validateFinite(camera.center.x, 'camera.center.x');
  const centerY = validateFinite(camera.center.y, 'camera.center.y');
  const scale = validateFinite(camera.scale, 'camera.scale');
  const width = validateFinite(viewport.width, 'viewport.width');
  const height = validateFinite(viewport.height, 'viewport.height');
  if (scale <= 0) throw new RangeError('renderer: camera.scale must be greater than zero');
  if (width < 0 || height < 0) {
    throw new RangeError('renderer: viewport dimensions must be non-negative');
  }
  const halfWidth = width / (2 * scale);
  const halfHeight = height / (2 * scale);
  const prefetch = CULL_PREFETCH_MARGIN_CSS_PX / scale;
  return {
    minX: centerX - halfWidth - prefetch,
    minY: centerY - halfHeight - prefetch,
    maxX: centerX + halfWidth + prefetch,
    maxY: centerY + halfHeight + prefetch,
  };
}

function visibleBatches(
  visible: Uint32Array,
  batchByPrimitive: Uint32Array,
): VisibleSpatialBatch[] {
  const groups = new Map<number, number[]>();
  for (const primitiveIndex of visible) {
    const batchIndex = batchByPrimitive[primitiveIndex]!;
    const group = groups.get(batchIndex);
    if (group === undefined) groups.set(batchIndex, [primitiveIndex]);
    else group.push(primitiveIndex);
  }
  return [...groups]
    .sort(([left], [right]) => left - right)
    .map(([batchIndex, primitiveIndices]) => ({
      batchIndex,
      indices: Uint32Array.from(primitiveIndices),
    }));
}

function countVisibleEdges(plan: ScenePlan, visibleSegments: Uint32Array): number {
  const visible = new Uint8Array(plan.edgeCount);
  for (const segmentIndex of visibleSegments) {
    visible[plan.edgeSegments.edgeIndices[segmentIndex]!] = 1;
  }
  let count = 0;
  for (const value of visible) count += value;
  return count;
}

function allVisibleBatches(
  batches: readonly SpatialBatch[],
): VisibleSpatialBatch[] {
  return batches.map((batch, batchIndex) => ({
    batchIndex,
    indices: batch.primitiveIndices,
  }));
}

function countGeometryEdges(geometry: SceneGeometryPlan): number {
  const visible = new Uint8Array(geometry.edgeCount);
  for (const edgeIndex of geometry.edgeSegments.edgeIndices) visible[edgeIndex] = 1;
  let count = 0;
  for (const value of visible) count += value;
  return count;
}

/** Draw-all fallback used only while the matching worker index is not ready. */
export function unculledSceneGeometry(
  geometry: SceneGeometryPlan,
  camera: CameraState,
  viewport: ViewportSize,
): CulledScene {
  const nodeBatches = allVisibleBatches(geometry.nodeBatches);
  const edgeBatches = allVisibleBatches(geometry.edgeBatches);
  const visibleEdges = countGeometryEdges(geometry);
  return {
    viewportBounds: viewportBounds(camera, viewport),
    nodeBatches,
    edgeBatches,
    stats: {
      modelNodes: geometry.nodeCount,
      candidateNodes: geometry.nodeCount,
      visibleNodes: geometry.nodeCount,
      culledNodes: 0,
      modelEdges: geometry.edgeCount,
      visibleEdges,
      culledEdges: geometry.edgeCount - visibleEdges,
      modelEdgeSegments: geometry.edgeSegments.edgeIndices.length,
      candidateEdgeSegments: geometry.edgeSegments.edgeIndices.length,
      visibleEdgeSegments: geometry.edgeSegments.edgeIndices.length,
      submittedNodeBatches: nodeBatches.length,
      submittedEdgeBatches: edgeBatches.length,
      drawCalls: nodeBatches.length + edgeBatches.length,
    },
  };
}

/** Query the camera viewport plus ADR-0021's prefetch band and group survivors. */
export function cullScenePlan(
  plan: ScenePlan,
  camera: CameraState,
  viewport: ViewportSize,
): CulledScene {
  const bounds = viewportBounds(camera, viewport);
  const nodeQuery = queryQuadtreeWithStats(plan.nodeTree, bounds);
  const edgeQuery = queryQuadtreeWithStats(plan.edgeTree, bounds);
  const visibleNodes = nodeQuery.indices;
  const visibleSegments = edgeQuery.indices;
  const nodeBatches = visibleBatches(visibleNodes, plan.nodeBatchByPrimitive);
  const edgeBatches = visibleBatches(visibleSegments, plan.edgeBatchByPrimitive);
  const visibleEdgeCount = countVisibleEdges(plan, visibleSegments);

  return {
    viewportBounds: bounds,
    nodeBatches,
    edgeBatches,
    stats: {
      modelNodes: plan.nodeCount,
      candidateNodes: nodeQuery.candidateCount,
      visibleNodes: visibleNodes.length,
      culledNodes: plan.nodeCount - visibleNodes.length,
      modelEdges: plan.edgeCount,
      visibleEdges: visibleEdgeCount,
      culledEdges: plan.edgeCount - visibleEdgeCount,
      modelEdgeSegments: plan.edgeSegments.edgeIndices.length,
      candidateEdgeSegments: edgeQuery.candidateCount,
      visibleEdgeSegments: visibleSegments.length,
      submittedNodeBatches: nodeBatches.length,
      submittedEdgeBatches: edgeBatches.length,
      drawCalls: nodeBatches.length + edgeBatches.length,
    },
  };
}
