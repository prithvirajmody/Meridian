import { describe, expect, it } from 'vitest';
import type { RenderModel } from '@meridian/view-model';
import {
  buildScenePlan,
  CULL_PREFETCH_MARGIN_CSS_PX,
  cullScenePlan,
  DEFAULT_SPATIAL_BATCH_SIZE,
} from '../src/scene-plan.js';

type NodeId = RenderModel['nodeIds'][number];
type RectTuple = readonly [x: number, y: number, width: number, height: number];
type PointTuple = readonly [x: number, y: number];
type EdgeTuple = readonly [source: number, target: number];

function boundsOf(rects: readonly RectTuple[]): RenderModel['bounds'] {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const minX = Math.min(...rects.map(([x]) => x));
  const minY = Math.min(...rects.map(([, y]) => y));
  const maxX = Math.max(...rects.map(([x, , width]) => x + width));
  const maxY = Math.max(...rects.map(([, y, , height]) => y + height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function modelOf(
  rects: readonly RectTuple[],
  edges: readonly EdgeTuple[] = [],
  routes: readonly (readonly PointTuple[])[] = [],
): RenderModel {
  const nodeIds = rects.map((_, index) => `n-${index}` as NodeId);
  const routeOffsets = [0];
  const routePoints: number[] = [];
  for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex++) {
    for (const point of routes[edgeIndex] ?? []) routePoints.push(...point);
    routeOffsets.push(routePoints.length / 2);
  }
  return {
    revision: `test-${rects.length}-${edges.length}`,
    bounds: boundsOf(rects),
    nodeIds,
    nodeRects: Float64Array.from(rects.flat()),
    nodeColorKeys: ['node'],
    nodeColorIds: new Uint16Array(rects.length),
    nodeFlags: new Uint8Array(rects.length),
    nodeCoveredLeaves: new Float64Array(rects.length).fill(1),
    nodeDegrees: new Uint32Array(rects.length),
    labelTable: nodeIds,
    labelRefs: Uint32Array.from(nodeIds.map((_, index) => index)),
    labelClasses: new Uint8Array(rects.length),
    edgeKeys: edges.map(([source, target]) => `n-${source}→n-${target}→test:edge`),
    edgeIndices: Uint32Array.from(edges.flat()),
    edgeColorKeys: edges.length > 0 ? ['test:edge'] : [],
    edgeColorIds: new Uint16Array(edges.length),
    edgeWeights: new Float64Array(edges.length).fill(1),
    edgeMultiplicities: new Uint32Array(edges.length).fill(1),
    edgeFlags: new Uint8Array(edges.length),
    edgeRouteOffsets: Uint32Array.from(routeOffsets),
    edgeRoutePoints: Float64Array.from(routePoints),
    diagnostics: [],
  };
}

describe('buildScenePlan', () => {
  it('returns a canonical plan and cull result for a zero-node model', () => {
    const plan = buildScenePlan(modelOf([]));

    expect(plan.nodeCount).toBe(0);
    expect(plan.edgeCount).toBe(0);
    expect(plan.nodeBatches).toEqual([]);
    expect(plan.edgeBatches).toEqual([]);
    expect(plan.edgeSegments.coordinates).toHaveLength(0);

    expect(
      cullScenePlan(
        plan,
        { center: { x: 0, y: 0 }, scale: 1 },
        { width: 800, height: 600 },
      ),
    ).toEqual({
      viewportBounds: { minX: -464, minY: -364, maxX: 464, maxY: 364 },
      nodeBatches: [],
      edgeBatches: [],
      stats: {
        modelNodes: 0,
        candidateNodes: 0,
        visibleNodes: 0,
        culledNodes: 0,
        modelEdges: 0,
        visibleEdges: 0,
        culledEdges: 0,
        modelEdgeSegments: 0,
        candidateEdgeSegments: 0,
        visibleEdgeSegments: 0,
        submittedNodeBatches: 0,
        submittedEdgeBatches: 0,
        drawCalls: 0,
      },
    });
  });

  it('Morton-sorts bounded batches and derives straight and routed segments', () => {
    const model = modelOf(
      [
        [90, 90, 10, 10],
        [0, 0, 10, 10],
        [90, 0, 10, 10],
        [0, 90, 10, 10],
      ],
      [
        [0, 1],
        [2, 3],
      ],
      [[], [[95, 5], [50, 50], [5, 95]]],
    );

    const first = buildScenePlan(model, { maxBatchSize: 2 });
    const second = buildScenePlan(model, { maxBatchSize: 2 });

    expect(first.nodeBatches.map(({ primitiveIndices }) => [...primitiveIndices])).toEqual([
      [1, 2],
      [3, 0],
    ]);
    expect(first.nodeBatches.every((batch) => batch.primitiveIndices.length <= 2)).toBe(true);
    expect(first.edgeBatches.every((batch) => batch.primitiveIndices.length <= 2)).toBe(true);
    expect([...first.edgeSegments.coordinates]).toEqual([
      95, 95, 5, 5,
      95, 5, 50, 50,
      50, 50, 5, 95,
    ]);
    expect([...first.edgeSegments.edgeIndices]).toEqual([0, 1, 1]);
    expect(first.nodeBatches).toEqual(second.nodeBatches);
    expect(first.edgeBatches).toEqual(second.edgeBatches);
    expect(first.nodeBatchByPrimitive).toEqual(second.nodeBatchByPrimitive);
    expect(first.edgeBatchByPrimitive).toEqual(second.edgeBatchByPrimitive);
  });

  it('keeps the production cap at 512 primitives per batch', () => {
    const rects = Array.from(
      { length: DEFAULT_SPATIAL_BATCH_SIZE + 1 },
      (_, index): RectTuple => [index * 2, 0, 1, 1],
    );
    const plan = buildScenePlan(modelOf(rects));

    expect(plan.nodeBatches).toHaveLength(2);
    expect(plan.nodeBatches[0]!.primitiveIndices).toHaveLength(DEFAULT_SPATIAL_BATCH_SIZE);
    expect(plan.nodeBatches[1]!.primitiveIndices).toHaveLength(1);
    expect(() => buildScenePlan(modelOf([]), { maxBatchSize: 513 })).toThrow('between 1 and 512');
  });
});

describe('cullScenePlan', () => {
  it('expands by the CSS-pixel prefetch band and counts unique visible model edges', () => {
    expect(CULL_PREFETCH_MARGIN_CSS_PX).toBe(64);
    const plan = buildScenePlan(
      modelOf(
        [
          [0, 0, 10, 10],
          [20, 0, 10, 10],
          [1_000, 0, 10, 10],
          [1_020, 0, 10, 10],
        ],
        [
          [0, 1],
          [2, 3],
        ],
      ),
      { maxBatchSize: 2 },
    );

    const culled = cullScenePlan(
      plan,
      { center: { x: 15, y: 5 }, scale: 10 },
      { width: 300, height: 100 },
    );

    expect(culled.viewportBounds).toEqual({ minX: -6.4, minY: -6.4, maxX: 36.4, maxY: 16.4 });
    expect(culled.nodeBatches.flatMap((batch) => [...batch.indices])).toEqual([0, 1]);
    expect(culled.edgeBatches.flatMap((batch) => [...batch.indices])).toEqual([0]);
    expect(culled.stats).toMatchObject({
      modelNodes: 4,
      candidateNodes: 4,
      visibleNodes: 2,
      culledNodes: 2,
      modelEdges: 2,
      visibleEdges: 1,
      culledEdges: 1,
      modelEdgeSegments: 2,
      candidateEdgeSegments: 2,
      visibleEdgeSegments: 1,
      submittedNodeBatches: 1,
      submittedEdgeBatches: 1,
      drawCalls: 2,
    });
  });

  it('reduces spatial draw batches as a large grid is zoomed into', () => {
    const side = 64;
    const rects = Array.from({ length: side * side }, (_, index): RectTuple => {
      const column = index % side;
      const row = Math.floor(index / side);
      return [column * 100, row * 100, 10, 10];
    });
    const plan = buildScenePlan(modelOf(rects), { maxBatchSize: 128 });
    const viewport = { width: 700, height: 700 };

    const overview = cullScenePlan(
      plan,
      { center: { x: 3_155, y: 3_155 }, scale: 0.1 },
      viewport,
    );
    const closeUp = cullScenePlan(
      plan,
      { center: { x: 5, y: 5 }, scale: 10 },
      { width: 100, height: 100 },
    );

    expect(overview.stats.visibleNodes).toBe(side * side);
    expect(overview.stats.drawCalls).toBe(32);
    expect(closeUp.stats.visibleNodes).toBe(1);
    expect(closeUp.stats.drawCalls).toBe(1);
    expect(closeUp.stats.drawCalls).toBeLessThan(overview.stats.drawCalls);
  });
});
