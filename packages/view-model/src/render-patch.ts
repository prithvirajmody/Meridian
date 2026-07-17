/**
 * Pure RenderModel diffing for the Phase 11 incremental pipeline. The full
 * next model remains the source of truth and fallback; the index lists tell a
 * renderer exactly which stable slots changed so same-topology updates do not
 * have to be treated as a brand-new scene.
 */
import type { RenderModel } from './render-model.js';

export interface RenderModelPatch {
  readonly fromRevision: string;
  readonly toRevision: string;
  readonly next: RenderModel;
  /** Identity/order or edge endpoint connectivity changed. */
  readonly topologyChanged: boolean;
  /** Node rectangles or edge routes/endpoints moved. */
  readonly geometryChanged: boolean;
  readonly changedNodeIndices: Uint32Array;
  readonly movedNodeIndices: Uint32Array;
  readonly changedEdgeIndices: Uint32Array;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function lane(lanes: Float32Array | undefined, index: number): number {
  return lanes?.[index] ?? 1;
}

function nodeLabel(model: RenderModel, index: number): string {
  return model.labelTable[model.labelRefs[index] ?? 0] ?? '';
}

function nodeColor(model: RenderModel, index: number): string {
  return model.nodeColorKeys[model.nodeColorIds[index] ?? 0] ?? '';
}

function edgeColor(model: RenderModel, index: number): string {
  return model.edgeColorKeys[model.edgeColorIds[index] ?? 0] ?? '';
}

function rectChanged(left: RenderModel, right: RenderModel, index: number): boolean {
  const offset = index * 4;
  for (let laneIndex = 0; laneIndex < 4; laneIndex++) {
    if (left.nodeRects[offset + laneIndex] !== right.nodeRects[offset + laneIndex]) return true;
  }
  return false;
}

function routeChanged(left: RenderModel, right: RenderModel, index: number): boolean {
  const leftStart = left.edgeRouteOffsets[index];
  const leftEnd = left.edgeRouteOffsets[index + 1];
  const rightStart = right.edgeRouteOffsets[index];
  const rightEnd = right.edgeRouteOffsets[index + 1];
  if (
    leftStart === undefined || leftEnd === undefined ||
    rightStart === undefined || rightEnd === undefined ||
    leftEnd - leftStart !== rightEnd - rightStart
  ) {
    return true;
  }
  const pointCount = leftEnd - leftStart;
  for (let point = 0; point < pointCount; point++) {
    const leftLane = (leftStart + point) * 2;
    const rightLane = (rightStart + point) * 2;
    if (
      left.edgeRoutePoints[leftLane] !== right.edgeRoutePoints[rightLane] ||
      left.edgeRoutePoints[leftLane + 1] !== right.edgeRoutePoints[rightLane + 1]
    ) {
      return true;
    }
  }
  return false;
}

function endpointChanged(left: RenderModel, right: RenderModel, index: number): boolean {
  const offset = index * 2;
  return (
    left.edgeIndices[offset] !== right.edgeIndices[offset] ||
    left.edgeIndices[offset + 1] !== right.edgeIndices[offset + 1]
  );
}

/** Diff two immutable models. Equal revisions intentionally produce an empty
 * patch without scanning the typed lanes. */
export function diffRenderModels(previous: RenderModel, next: RenderModel): RenderModelPatch {
  if (previous.revision === next.revision) {
    return {
      fromRevision: previous.revision,
      toRevision: next.revision,
      next,
      topologyChanged: false,
      geometryChanged: false,
      changedNodeIndices: new Uint32Array(),
      movedNodeIndices: new Uint32Array(),
      changedEdgeIndices: new Uint32Array(),
    };
  }

  const topologyChanged =
    !sameStrings(previous.nodeIds, next.nodeIds) ||
    !sameStrings(previous.edgeKeys, next.edgeKeys) ||
    previous.edgeIndices.length !== next.edgeIndices.length ||
    (() => {
      for (let index = 0; index < previous.edgeKeys.length; index++) {
        if (endpointChanged(previous, next, index)) return true;
      }
      return false;
    })();

  if (topologyChanged) {
    return {
      fromRevision: previous.revision,
      toRevision: next.revision,
      next,
      topologyChanged: true,
      geometryChanged: true,
      changedNodeIndices: Uint32Array.from(next.nodeIds, (_, index) => index),
      movedNodeIndices: Uint32Array.from(next.nodeIds, (_, index) => index),
      changedEdgeIndices: Uint32Array.from(next.edgeKeys, (_, index) => index),
    };
  }

  const changedNodes: number[] = [];
  const movedNodes: number[] = [];
  const moved = new Uint8Array(next.nodeIds.length);
  for (let index = 0; index < next.nodeIds.length; index++) {
    const didMove = rectChanged(previous, next, index);
    if (didMove) {
      moved[index] = 1;
      movedNodes.push(index);
    }
    if (
      didMove ||
      previous.nodeFlags[index] !== next.nodeFlags[index] ||
      previous.nodeCoveredLeaves[index] !== next.nodeCoveredLeaves[index] ||
      previous.nodeDegrees[index] !== next.nodeDegrees[index] ||
      previous.labelClasses[index] !== next.labelClasses[index] ||
      nodeLabel(previous, index) !== nodeLabel(next, index) ||
      nodeColor(previous, index) !== nodeColor(next, index) ||
      lane(previous.nodeAlphas, index) !== lane(next.nodeAlphas, index)
    ) {
      changedNodes.push(index);
    }
  }

  const changedEdges: number[] = [];
  let routeGeometryChanged = false;
  for (let index = 0; index < next.edgeKeys.length; index++) {
    const offset = index * 2;
    const routeMoved = routeChanged(previous, next, index);
    const incidentMoved =
      moved[next.edgeIndices[offset] ?? 0] === 1 || moved[next.edgeIndices[offset + 1] ?? 0] === 1;
    if (routeMoved || incidentMoved) routeGeometryChanged = true;
    if (
      routeMoved || incidentMoved ||
      previous.edgeFlags[index] !== next.edgeFlags[index] ||
      previous.edgeWeights[index] !== next.edgeWeights[index] ||
      previous.edgeMultiplicities[index] !== next.edgeMultiplicities[index] ||
      edgeColor(previous, index) !== edgeColor(next, index) ||
      lane(previous.edgeAlphas, index) !== lane(next.edgeAlphas, index)
    ) {
      changedEdges.push(index);
    }
  }

  return {
    fromRevision: previous.revision,
    toRevision: next.revision,
    next,
    topologyChanged: false,
    geometryChanged: movedNodes.length > 0 || routeGeometryChanged,
    changedNodeIndices: Uint32Array.from(changedNodes),
    movedNodeIndices: Uint32Array.from(movedNodes),
    changedEdgeIndices: Uint32Array.from(changedEdges),
  };
}
