import type { NodeId, RenderModel } from '@meridian/view-model';

export type RectTuple = readonly [x: number, y: number, width: number, height: number];
export type EdgeTuple = readonly [source: number, target: number];

export interface ModelOverrides {
  readonly labels?: readonly string[];
  readonly labelClasses?: readonly number[];
  readonly coveredLeaves?: readonly number[];
  readonly degrees?: readonly number[];
  readonly nodeFlags?: readonly number[];
  readonly routes?: readonly (readonly (readonly [number, number])[])[];
}

function boundsOf(rects: readonly RectTuple[]): RenderModel['bounds'] {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const minX = Math.min(...rects.map(([x]) => x));
  const minY = Math.min(...rects.map(([, y]) => y));
  const maxX = Math.max(...rects.map(([x, , width]) => x + width));
  const maxY = Math.max(...rects.map(([, y, , height]) => y + height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Build a deterministic RenderModel for headless label/pick tests. */
export function modelOf(
  rects: readonly RectTuple[],
  edges: readonly EdgeTuple[] = [],
  overrides: ModelOverrides = {},
): RenderModel {
  const nodeIds = rects.map((_, index) => `n-${index}` as NodeId);
  const labels = overrides.labels ?? nodeIds;
  const labelTable = [...labels];
  const routeOffsets = [0];
  const routePoints: number[] = [];
  for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex++) {
    for (const point of overrides.routes?.[edgeIndex] ?? []) routePoints.push(...point);
    routeOffsets.push(routePoints.length / 2);
  }
  return {
    revision: `test-${rects.length}-${edges.length}`,
    bounds: boundsOf(rects),
    nodeIds,
    nodeRects: Float64Array.from(rects.flat()),
    nodeColorKeys: ['node'],
    nodeColorIds: new Uint16Array(rects.length),
    nodeFlags: Uint8Array.from(rects.map((_, index) => overrides.nodeFlags?.[index] ?? 0)),
    nodeCoveredLeaves: Float64Array.from(rects.map((_, index) => overrides.coveredLeaves?.[index] ?? 1)),
    nodeDegrees: Uint32Array.from(rects.map((_, index) => overrides.degrees?.[index] ?? 0)),
    labelTable,
    labelRefs: Uint32Array.from(labels.map((_, index) => index)),
    labelClasses: Uint8Array.from(rects.map((_, index) => overrides.labelClasses?.[index] ?? 3)),
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
