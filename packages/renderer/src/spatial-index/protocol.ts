/**
 * Typed-array wire protocol for ADR-0021's off-main spatial-index build.
 *
 * The request owns disposable geometry buffers. Posting it with
 * {@link spatialIndexRequestTransfer} moves those buffers to the worker. The
 * response moves both packed quadtrees back to the host. Model/string identity
 * deliberately stays on the main thread; tree item indices refer to the
 * caller's node index or packed edge-segment index.
 */
import type { PackedQuadtree } from '../quadtree.js';

export interface SpatialIndexBuildRequest {
  readonly type: 'build';
  readonly requestId: number;
  readonly modelRevision: string;
  /** `[x,y,width,height]` per model node. */
  readonly nodeRects: Float64Array;
  /** `[x1,y1,x2,y2]` per packed edge segment. */
  readonly edgeSegments: Float64Array;
}

export interface SpatialIndexCancelRequest {
  readonly type: 'cancel';
  readonly requestId: number;
}

export type SpatialIndexWorkerRequest =
  | SpatialIndexBuildRequest
  | SpatialIndexCancelRequest;

export interface SpatialIndexBuildResponse {
  readonly type: 'built';
  readonly requestId: number;
  readonly modelRevision: string;
  readonly nodeTree: PackedQuadtree;
  readonly edgeTree: PackedQuadtree;
}

export interface SpatialIndexErrorResponse {
  readonly type: 'error';
  readonly requestId: number;
  readonly modelRevision: string;
  readonly message: string;
  readonly stack?: string;
}

export interface SpatialIndexCancelledResponse {
  readonly type: 'cancelled';
  readonly requestId: number;
}

export type SpatialIndexWorkerResponse =
  | SpatialIndexBuildResponse
  | SpatialIndexErrorResponse
  | SpatialIndexCancelledResponse;

function transferableBuffer(view: ArrayBufferView, name: string): ArrayBuffer {
  const buffer = view.buffer;
  if (!(buffer instanceof ArrayBuffer)) {
    throw new TypeError(`renderer: ${name} must be backed by a transferable ArrayBuffer`);
  }
  return buffer;
}

function uniqueBuffers(
  entries: readonly (readonly [ArrayBufferView, string])[],
): ArrayBuffer[] {
  const seen = new Set<ArrayBuffer>();
  const result: ArrayBuffer[] = [];
  for (const [view, name] of entries) {
    const buffer = transferableBuffer(view, name);
    if (seen.has(buffer)) continue;
    seen.add(buffer);
    result.push(buffer);
  }
  return result;
}

/** Buffers moved host → worker for one build request. */
export function spatialIndexRequestTransfer(
  request: SpatialIndexBuildRequest,
): ArrayBuffer[] {
  return uniqueBuffers([
    [request.nodeRects, 'spatial-index nodeRects'],
    [request.edgeSegments, 'spatial-index edgeSegments'],
  ]);
}

function treeEntries(
  tree: PackedQuadtree,
  prefix: string,
): readonly (readonly [ArrayBufferView, string])[] {
  return [
    [tree.nodeBounds, `${prefix}.nodeBounds`],
    [tree.childOffsets, `${prefix}.childOffsets`],
    [tree.itemOffsets, `${prefix}.itemOffsets`],
    [tree.itemIndices, `${prefix}.itemIndices`],
    [tree.itemBounds, `${prefix}.itemBounds`],
  ];
}

/** Buffers moved worker → host for one successful build response. */
export function spatialIndexResponseTransfer(
  response: SpatialIndexBuildResponse,
): ArrayBuffer[] {
  return uniqueBuffers([
    ...treeEntries(response.nodeTree, 'spatial-index nodeTree'),
    ...treeEntries(response.edgeTree, 'spatial-index edgeTree'),
  ]);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function isRequestId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/** Runtime guard used at the worker boundary. */
export function isSpatialIndexWorkerRequest(
  value: unknown,
): value is SpatialIndexWorkerRequest {
  if (!isRecord(value) || !isRequestId(value.requestId)) return false;
  if (value.type === 'cancel') return true;
  return (
    value.type === 'build' &&
    typeof value.modelRevision === 'string' &&
    value.nodeRects instanceof Float64Array &&
    value.edgeSegments instanceof Float64Array
  );
}

/** Runtime guard used at the host boundary; it intentionally stays O(1). */
export function isSpatialIndexWorkerResponse(
  value: unknown,
): value is SpatialIndexWorkerResponse {
  if (!isRecord(value) || !isRequestId(value.requestId)) return false;
  if (value.type === 'cancelled') return true;
  if (value.type === 'error') {
    return typeof value.modelRevision === 'string' && typeof value.message === 'string';
  }
  if (value.type !== 'built' || typeof value.modelRevision !== 'string') return false;
  return isPackedQuadtree(value.nodeTree) && isPackedQuadtree(value.edgeTree);
}

function isPackedQuadtree(value: unknown): value is PackedQuadtree {
  if (!isRecord(value)) return false;
  const nodeBounds = value.nodeBounds;
  const childOffsets = value.childOffsets;
  const itemOffsets = value.itemOffsets;
  const itemIndices = value.itemIndices;
  const itemBounds = value.itemBounds;
  if (
    !(nodeBounds instanceof Float64Array) ||
    !(childOffsets instanceof Int32Array) ||
    !(itemOffsets instanceof Uint32Array) ||
    !(itemIndices instanceof Uint32Array) ||
    !(itemBounds instanceof Float64Array)
  ) {
    return false;
  }
  return (
    nodeBounds.length === childOffsets.length * 4 &&
    itemOffsets.length === childOffsets.length + 1 &&
    itemBounds.length === itemIndices.length * 4 &&
    itemOffsets[itemOffsets.length - 1] === itemIndices.length
  );
}
