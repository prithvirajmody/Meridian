import type {
  NodeId,
  RenderDiagnostic,
  RenderModel,
} from '@meridian/view-model';
import {
  LABEL_CLASS_CONNECTED,
  LABEL_CLASS_FORCED,
  LABEL_CLASS_SUMMARY,
  NODE_FLAG_SELECTED,
  NODE_FLAG_SELECTION_ANCHOR,
} from '@meridian/view-model';

function emptyModel(revision: string): RenderModel {
  return {
    revision,
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    nodeIds: [],
    nodeRects: new Float64Array(),
    nodeColorKeys: [],
    nodeColorIds: new Uint16Array(),
    nodeFlags: new Uint8Array(),
    nodeCoveredLeaves: new Float64Array(),
    nodeDegrees: new Uint32Array(),
    labelTable: [],
    labelRefs: new Uint32Array(),
    labelClasses: new Uint8Array(),
    edgeKeys: [],
    edgeIndices: new Uint32Array(),
    edgeColorKeys: [],
    edgeColorIds: new Uint16Array(),
    edgeWeights: new Float64Array(),
    edgeMultiplicities: new Uint32Array(),
    edgeFlags: new Uint8Array(),
    edgeRouteOffsets: new Uint32Array([0]),
    edgeRoutePoints: new Float64Array(),
    diagnostics: [],
  };
}

export function createEmptyRenderModel(): RenderModel {
  return emptyModel('studio-fixture-empty');
}

export function createPerformanceRenderModel(side = 100): RenderModel {
  const count = side * side;
  const nodeIds = Array.from(
    { length: count },
    (_, index) => `perf:node:${index.toString().padStart(5, '0')}` as NodeId,
  );
  const nodeRects = new Float64Array(count * 4);
  const labelRefs = new Uint32Array(count);
  const labelClasses = new Uint8Array(count);
  const nodeFlags = new Uint8Array(count);
  const coveredLeaves = new Float64Array(count).fill(1);
  const edgePairs: number[] = [];
  const edgeKeys: string[] = [];
  for (let index = 0; index < count; index++) {
    const column = index % side;
    const row = Math.floor(index / side);
    nodeRects.set([column * 48, row * 36, 20, 14], index * 4);
    labelRefs[index] = index;
    if (index === 0) {
      labelClasses[index] = LABEL_CLASS_FORCED;
      nodeFlags[index] = NODE_FLAG_SELECTED | NODE_FLAG_SELECTION_ANCHOR;
    } else if (index % 32 === 0) {
      labelClasses[index] = LABEL_CLASS_SUMMARY;
      coveredLeaves[index] = 4;
    } else {
      labelClasses[index] = LABEL_CLASS_CONNECTED;
    }
    if (column + 1 < side) {
      edgePairs.push(index, index + 1);
      edgeKeys.push(`${nodeIds[index]}→${nodeIds[index + 1]}→perf:next`);
    }
  }
  const edgeCount = edgeKeys.length;
  return {
    ...emptyModel(`studio-fixture-performance-${count}`),
    bounds: {
      x: 0,
      y: 0,
      width: (side - 1) * 48 + 20,
      height: (side - 1) * 36 + 14,
    },
    nodeIds,
    nodeRects,
    nodeColorKeys: ['perf:node'],
    nodeColorIds: new Uint16Array(count),
    nodeFlags,
    nodeCoveredLeaves: coveredLeaves,
    nodeDegrees: new Uint32Array(count).fill(2),
    labelTable: nodeIds,
    labelRefs,
    labelClasses,
    edgeKeys,
    edgeIndices: Uint32Array.from(edgePairs),
    edgeColorKeys: ['perf:edge'],
    edgeColorIds: new Uint16Array(edgeCount),
    edgeWeights: new Float64Array(edgeCount).fill(1),
    edgeMultiplicities: new Uint32Array(edgeCount).fill(1),
    edgeFlags: new Uint8Array(edgeCount),
    edgeRouteOffsets: new Uint32Array(edgeCount + 1),
  };
}

export function createUnicodeRenderModel(): RenderModel {
  const labels = [
    '図書館カタログ',
    '🚀 Launch ✨ (with ZWJ: 👩‍🔬)',
    'مكتبة الوسائط',
    'cafe\u0301'.normalize('NFC'),
  ];
  const nodeIds = ['n-cjk', 'n-emoji', 'n-rtl', 'n-decomposed'] as NodeId[];
  const nodeRects = new Float64Array([
    0, 0, 220, 64,
    260, 0, 220, 64,
    0, 120, 220, 64,
    260, 120, 220, 64,
  ]);
  return {
    ...emptyModel('studio-fixture-unicode'),
    bounds: { x: 0, y: 0, width: 480, height: 184 },
    nodeIds,
    nodeRects,
    nodeColorKeys: ['fixture:unicode'],
    nodeColorIds: new Uint16Array(4),
    nodeFlags: new Uint8Array(4),
    nodeCoveredLeaves: new Float64Array(4).fill(1),
    nodeDegrees: new Uint32Array(4),
    labelTable: labels,
    labelRefs: Uint32Array.from([0, 1, 2, 3]),
    labelClasses: new Uint8Array(4).fill(3),
  };
}

export function createHostileLayoutRenderModel(): RenderModel {
  const diagnostic: RenderDiagnostic = {
    code: 'non-finite-position',
    element: 'node',
    id: 'hostile:node',
    field: 'x',
    received: 'NaN',
  };
  return {
    ...emptyModel('studio-fixture-hostile-layout'),
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    nodeIds: ['hostile:node' as NodeId],
    nodeRects: new Float64Array([0, 0, 0, 0]),
    nodeColorKeys: ['fixture:hostile'],
    nodeColorIds: new Uint16Array(1),
    nodeFlags: new Uint8Array(1),
    nodeCoveredLeaves: new Float64Array([1]),
    nodeDegrees: new Uint32Array(1),
    labelTable: ['Clamped hostile node'],
    labelRefs: new Uint32Array([0]),
    labelClasses: new Uint8Array([0]),
    diagnostics: [diagnostic],
  };
}
