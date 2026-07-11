import {
  LABEL_CLASS_CONNECTED,
  LABEL_CLASS_FORCED,
  LABEL_CLASS_SUMMARY,
  NODE_FLAG_SELECTED,
  NODE_FLAG_SELECTION_ANCHOR,
  type NodeId,
  type RenderModel,
} from '@meridian/view-model';

/** Deterministic labelled grid used by the bare renderer harness and FPS probe. */
export function createHarnessFixture(side = 100): RenderModel {
  if (!Number.isSafeInteger(side) || side < 1) {
    throw new RangeError('renderer harness: side must be a positive safe integer');
  }
  const count = side * side;
  const nodeIds = Array.from({ length: count }, (_, index) => `fixture:${index}` as NodeId);
  const nodeRects = new Float64Array(count * 4);
  const nodeFlags = new Uint8Array(count);
  const nodeCoveredLeaves = new Float64Array(count).fill(1);
  const nodeDegrees = new Uint32Array(count);
  const labelRefs = new Uint32Array(count);
  const labelClasses = new Uint8Array(count);
  const edgePairs: number[] = [];
  const edgeKeys: string[] = [];

  for (let index = 0; index < count; index++) {
    const column = index % side;
    const row = Math.floor(index / side);
    nodeRects.set([column * 48, row * 36, 20, 14], index * 4);
    labelRefs[index] = index;

    if (index === 0) {
      // A RenderModel has one forced selection anchor, never thousands of
      // class-0 labels. This keeps the fixture semantically representative.
      labelClasses[index] = LABEL_CLASS_FORCED;
      nodeFlags[index] = NODE_FLAG_SELECTED | NODE_FLAG_SELECTION_ANCHOR;
    } else if (index % 32 === 0) {
      labelClasses[index] = LABEL_CLASS_SUMMARY;
      nodeCoveredLeaves[index] = 4;
    } else {
      labelClasses[index] = LABEL_CLASS_CONNECTED;
    }

    if (column > 0) nodeDegrees[index]! += 1;
    if (column + 1 < side) {
      nodeDegrees[index]! += 1;
      edgePairs.push(index, index + 1);
      edgeKeys.push(`${nodeIds[index]}→${nodeIds[index + 1]}→fixture:next`);
    }
  }

  const edgeCount = edgeKeys.length;
  return {
    revision: `renderer-harness-${side}`,
    bounds: { x: 0, y: 0, width: (side - 1) * 48 + 20, height: (side - 1) * 36 + 14 },
    nodeIds,
    nodeRects,
    nodeColorKeys: ['fixture:node'],
    nodeColorIds: new Uint16Array(count),
    nodeFlags,
    nodeCoveredLeaves,
    nodeDegrees,
    labelTable: nodeIds,
    labelRefs,
    labelClasses,
    edgeKeys,
    edgeIndices: Uint32Array.from(edgePairs),
    edgeColorKeys: edgeCount === 0 ? [] : ['fixture:edge'],
    edgeColorIds: new Uint16Array(edgeCount),
    edgeWeights: new Float64Array(edgeCount).fill(1),
    edgeMultiplicities: new Uint32Array(edgeCount).fill(1),
    edgeFlags: new Uint8Array(edgeCount),
    edgeRouteOffsets: new Uint32Array(edgeCount + 1),
    edgeRoutePoints: new Float64Array(),
    diagnostics: [],
  };
}
