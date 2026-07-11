import { describe, expect, it } from 'vitest';
import {
  NODE_FLAG_SELECTED,
  type CameraState,
  type Point,
  type RenderModel,
  type ViewportSize,
} from '@meridian/view-model';
import { hitTest } from '../src/picking/hit-test.js';
import { buildScenePlan, cullScenePlan } from '../src/scene-plan.js';
import { orderVisibleNodeBatches } from '../src/visual-order.js';
import { modelOf, type RectTuple } from './support/model.js';

const CAMERA: CameraState = { center: { x: 70, y: 50 }, scale: 1 };
const VIEWPORT: ViewportSize = { width: 200, height: 160 };
const OVERLAP_SCREEN: Point = { x: 90, y: 80 }; // world (60,50)
const OVERLAPS: RectTuple[] = [
  [40, 0, 100, 100], // index 0, greater Morton center
  [0, 0, 100, 100],  // index 1, lower Morton center but greater model index
];

function topDrawnIndex(
  model: RenderModel,
  hoverNodeIndex: number | null,
): { raw: number[]; ordered: number[]; picked: number } {
  const plan = buildScenePlan(model, { maxBatchSize: 1 });
  const culled = cullScenePlan(plan, CAMERA, VIEWPORT);
  const raw = culled.nodeBatches.flatMap((batch) => [...batch.indices]);
  const batches = orderVisibleNodeBatches(model, culled.nodeBatches, hoverNodeIndex, 1);
  const ordered = batches.flatMap((batch) => [...batch.indices]);
  const picked = hitTest({
    model,
    nodeTree: plan.nodeTree,
    edgeTree: plan.edgeTree,
    edgeSegments: plan.edgeSegments,
    camera: CAMERA,
    viewport: VIEWPORT,
    screen: OVERLAP_SCREEN,
    hoverNodeIndex,
  });
  if (picked?.kind !== 'node') throw new Error('test setup: expected an overlapping node pick');
  return { raw, ordered, picked: picked.nodeIndex };
}

describe('ADR-0021 shared visual draw order', () => {
  it('corrects a cross-Morton-batch overlap to greater-model-index topmost', () => {
    const result = topDrawnIndex(modelOf(OVERLAPS), null);

    // This is the original gap: Morton batches would paint index 0 last while
    // picking correctly chooses the greater model index 1.
    expect(result.raw).toEqual([1, 0]);
    expect(result.ordered).toEqual([0, 1]);
    expect(result.ordered.at(-1)).toBe(result.picked);
    expect(result.picked).toBe(1);
  });

  it.each([
    {
      name: 'selected layer',
      model: modelOf(OVERLAPS, [], { nodeFlags: [NODE_FLAG_SELECTED, 0] }),
      hoverNodeIndex: null,
      expected: 0,
    },
    {
      name: 'hover layer',
      model: modelOf(OVERLAPS),
      hoverNodeIndex: 0,
      expected: 0,
    },
  ])('paints the $name winner last, matching picking', ({ model, hoverNodeIndex, expected }) => {
    const result = topDrawnIndex(model, hoverNodeIndex);

    expect(result.ordered.at(-1)).toBe(result.picked);
    expect(result.picked).toBe(expected);
  });

  it('keeps batches bounded and never increases the culled node draw-call count', () => {
    const maxBatchSize = 128;
    const rects: RectTuple[] = Array.from(
      { length: 1_025 },
      (_, index) => [index % 40, Math.floor(index / 40), 2, 2],
    );
    const nodeFlags = rects.map((_, index) => (index % 19 === 0 ? NODE_FLAG_SELECTED : 0));
    const model = modelOf(rects, [], { nodeFlags });
    const plan = buildScenePlan(model, { maxBatchSize });
    const culled = cullScenePlan(
      plan,
      { center: { x: 20, y: 15 }, scale: 1 },
      { width: 200, height: 200 },
    );

    const ordered = orderVisibleNodeBatches(model, culled.nodeBatches, 7, maxBatchSize);

    expect(ordered.every((batch) => batch.indices.length <= maxBatchSize)).toBe(true);
    expect(ordered).toHaveLength(Math.ceil(culled.stats.visibleNodes / maxBatchSize));
    expect(ordered.length).toBeLessThanOrEqual(culled.stats.submittedNodeBatches);
    expect(ordered.flatMap((batch) => [...batch.indices])).toHaveLength(
      culled.stats.visibleNodes,
    );
  });
});
