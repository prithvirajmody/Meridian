/**
 * Pure node draw ordering shared with ADR-0021 picking.
 *
 * Spatial/Morton batches remain the culling substrate. Once culling has chosen
 * the visible indices, this module compacts them into the already-allocated GPU
 * batches in painter order: normal, selected, hover; ascending model index
 * within each layer. Rechunking can only preserve or reduce the number of
 * submitted node batches because every input batch is already bounded by the
 * same capacity.
 */
import { NODE_FLAG_SELECTED, type RenderModel } from '@meridian/view-model';
import type { VisibleSpatialBatch } from './scene-plan.js';

/** Higher values are painted later and are therefore topmost. */
export function visualLayer(
  model: RenderModel,
  index: number,
  hoverNodeIndex: number | null,
): 0 | 1 | 2 {
  if (index === hoverNodeIndex) return 2;
  if (((model.nodeFlags[index] ?? 0) & NODE_FLAG_SELECTED) !== 0) return 1;
  return 0;
}

function appendChunked(
  output: VisibleSpatialBatch[],
  indices: readonly number[],
  maxBatchSize: number,
): void {
  for (let start = 0; start < indices.length; start += maxBatchSize) {
    output.push({
      batchIndex: output.length,
      indices: Uint32Array.from(indices.slice(start, start + maxBatchSize)),
    });
  }
}

/**
 * Compact visible Morton groups into globally deterministic painter-order
 * batches without increasing draw calls.
 */
export function orderVisibleNodeBatches(
  model: RenderModel,
  visible: readonly VisibleSpatialBatch[],
  hoverNodeIndex: number | null,
  maxBatchSize: number,
): VisibleSpatialBatch[] {
  if (!Number.isSafeInteger(maxBatchSize) || maxBatchSize < 1) {
    throw new RangeError('renderer: visual-order maxBatchSize must be a positive safe integer');
  }

  // The model index is dense and bounded. A byte mask makes ordering O(N + V)
  // rather than sorting V indices every animation frame, and deduplicates any
  // hostile repeated input without changing the normal culling path.
  const visibleMask = new Uint8Array(model.nodeIds.length);
  let visibleCount = 0;
  for (const batch of visible) {
    for (const index of batch.indices) {
      if (index >= visibleMask.length) {
        throw new RangeError(`renderer: visible node index ${index} is out of range`);
      }
      if (visibleMask[index] === 0) {
        visibleMask[index] = 1;
        visibleCount++;
      }
    }
  }
  if (visibleCount === 0) return [];

  const normal: number[] = [];
  const selected: number[] = [];
  let hovered: number | null = null;
  for (let index = 0; index < visibleMask.length; index++) {
    if (visibleMask[index] === 0) continue;
    const layer = visualLayer(model, index, hoverNodeIndex);
    if (layer === 2) hovered = index;
    else if (layer === 1) selected.push(index);
    else normal.push(index);
  }

  const ordered = [...normal, ...selected];
  if (hovered !== null) ordered.push(hovered);
  const output: VisibleSpatialBatch[] = [];
  appendChunked(output, ordered, maxBatchSize);
  return output;
}
