import { describe, expect, it } from 'vitest';
import { NODE_FLAG_SELECTED, type CameraState, type Point, type ViewportSize } from '@meridian/view-model';
import { buildScenePlan } from '../src/scene-plan.js';
import { hitTest, type HitTestInput } from '../src/picking/hit-test.js';
import { modelOf, type EdgeTuple, type RectTuple } from './support/model.js';

const VIEWPORT: ViewportSize = { width: 800, height: 600 };

function inputFor(
  rects: readonly RectTuple[],
  edges: readonly EdgeTuple[],
  screen: Point,
  options: { camera?: CameraState; hoverNodeIndex?: number | null; nodeFlags?: readonly number[] } = {},
): HitTestInput {
  const model = modelOf(rects, edges, options.nodeFlags ? { nodeFlags: options.nodeFlags } : {});
  const plan = buildScenePlan(model);
  return {
    model,
    nodeTree: plan.nodeTree,
    edgeTree: plan.edgeTree,
    edgeSegments: plan.edgeSegments,
    camera: options.camera ?? { center: { x: 0, y: 0 }, scale: 1 },
    viewport: VIEWPORT,
    screen,
    hoverNodeIndex: options.hoverNodeIndex ?? null,
  };
}

describe('ADR-0021 node picking', () => {
  it('picks the node under the point', () => {
    const result = hitTest(inputFor([[10, 10, 20, 20]], [], { x: 420, y: 320 }));
    expect(result).toMatchObject({ kind: 'node', nodeIndex: 0, nodeId: 'n-0' });
  });

  it('resolves a shared boundary to the greater model index', () => {
    const result = hitTest(
      inputFor([[0, 0, 10, 10], [10, 0, 10, 10]], [], { x: 410, y: 305 }),
    );
    expect(result).toMatchObject({ kind: 'node', nodeIndex: 1 });
  });

  it('prefers the hovered node on an overlap tie', () => {
    const rects: RectTuple[] = [[0, 0, 20, 20], [5, 5, 5, 5]];
    const point: Point = { x: 407, y: 307 };
    expect(hitTest(inputFor(rects, [], point))).toMatchObject({ nodeIndex: 1 });
    expect(hitTest(inputFor(rects, [], point, { hoverNodeIndex: 0 }))).toMatchObject({ nodeIndex: 0 });
  });

  it('prefers a selected node over a greater-index unselected overlap', () => {
    const rects: RectTuple[] = [[0, 0, 20, 20], [5, 5, 5, 5]];
    const result = hitTest(
      inputFor(rects, [], { x: 407, y: 307 }, { nodeFlags: [NODE_FLAG_SELECTED, 0] }),
    );
    expect(result).toMatchObject({ nodeIndex: 0 });
  });

  it('picks a zero-size node inside its 6x6 marker and misses outside it', () => {
    const rects: RectTuple[] = [[50, 50, 0, 0]];
    expect(hitTest(inputFor(rects, [], { x: 452, y: 350 }))).toMatchObject({ nodeIndex: 0 });
    expect(hitTest(inputFor(rects, [], { x: 450, y: 353 }))).toMatchObject({ nodeIndex: 0 });
    expect(hitTest(inputFor(rects, [], { x: 450, y: 354 }))).toBeNull();
  });

});

describe('ADR-0021 edge picking', () => {
  const rects: RectTuple[] = [[0, 0, 10, 10], [100, 0, 10, 10]];
  const edges: EdgeTuple[] = [[0, 1]];

  it('never returns an edge when a node also matches near an endpoint', () => {
    const result = hitTest(inputFor(rects, edges, { x: 405, y: 305 }));
    expect(result).toMatchObject({ kind: 'node' });
  });

  it('picks an edge within 4 CSS px (inclusive) of the segment', () => {
    const hit = hitTest(inputFor(rects, edges, { x: 450, y: 309 }));
    expect(hit).toMatchObject({ kind: 'edge', edgeKey: 'n-0→n-1→test:edge' });
  });

  it('misses an edge beyond 4 CSS px', () => {
    expect(hitTest(inputFor(rects, edges, { x: 450, y: 309.5 }))).toBeNull();
  });

  it('breaks an edge tie by greater rendered edge index', () => {
    // Two edges tracing the same screen path but with distinct endpoints/keys.
    const fourNodes: RectTuple[] = [
      [0, 0, 10, 10],
      [100, 0, 10, 10],
      [0, 0, 10, 10],
      [100, 0, 10, 10],
    ];
    const twoEdges: EdgeTuple[] = [[0, 1], [2, 3]];
    const hit = hitTest(inputFor(fourNodes, twoEdges, { x: 450, y: 305 }));
    expect(hit).toMatchObject({ kind: 'edge', edgeKey: 'n-2→n-3→test:edge' });
  });
});
