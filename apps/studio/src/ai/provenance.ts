/**
 * Pure provenance helpers for the Studio AI human-trust surface (subphase 8F,
 * ADR-0031). Two jobs, both pure and headless:
 *
 * 1. `collectAiOriginNodeIds` — which nodes in a snapshot are AI-origin
 *    (`provenance.origin === 'ai'`, §8.1.3). This is the set the badge/overlay
 *    marks and the provenance filter hides.
 * 2. `filterRenderModelNodes` — the "evidence-only" view operation. It returns a
 *    new `RenderModel` with the named nodes and their incident edges removed,
 *    reindexed. It is a *view* transform: it removes nothing from the store
 *    (ADR-0031 — "filtering is a view predicate over the origin tag; nothing is
 *    removed, so the toggle is lossless and reversible").
 *
 * No DOM, Pixi, store, or AI-SDK import crosses this module (§20). The render
 * model is treated as immutable input; a fresh model is returned.
 */
import type { GraphSpace, NodeId, RenderModel } from '@meridian/view-model';

/** Node ids whose provenance is AI-derived (`origin === 'ai'`), across all graphs. */
export function collectAiOriginNodeIds(space: GraphSpace): Set<NodeId> {
  const result = new Set<NodeId>();
  for (const graph of space.graphs.values()) {
    for (const node of graph.nodes.values()) {
      if (node.provenance.origin === 'ai') result.add(node.id);
    }
  }
  return result;
}

/** The AI-origin node ids that are actually present in a render model's cut. */
export function aiOriginNodesInModel(
  model: RenderModel,
  aiOrigin: ReadonlySet<NodeId>,
): NodeId[] {
  return model.nodeIds.filter((id) => aiOrigin.has(id));
}

/**
 * Return a render model with `hidden` nodes (and any edge touching one) removed
 * and everything reindexed. Shared string tables (`labelTable`, `nodeColorKeys`,
 * `edgeColorKeys`) are kept intact — their indices remain valid for the kept
 * rows, and a superset table is harmless. `bounds` is preserved so the camera
 * framing and minimap do not jump when the filter toggles. Node degrees are
 * recomputed over the surviving edges so the filtered view is internally
 * consistent.
 */
export function filterRenderModelNodes(
  model: RenderModel,
  hidden: ReadonlySet<NodeId>,
): RenderModel {
  if (hidden.size === 0) return model;

  // ---- nodes: old index → new index, dropping hidden ----------------------
  const keptNodeIds: NodeId[] = [];
  const oldToNew = new Map<number, number>();
  for (let i = 0; i < model.nodeIds.length; i++) {
    const id = model.nodeIds[i]!;
    if (hidden.has(id)) continue;
    oldToNew.set(i, keptNodeIds.length);
    keptNodeIds.push(id);
  }
  const n = keptNodeIds.length;

  const nodeRects = new Float64Array(4 * n);
  const nodeColorIds = new Uint16Array(n);
  const nodeFlags = new Uint8Array(n);
  const nodeCoveredLeaves = new Float64Array(n);
  const nodeDegrees = new Uint32Array(n);
  const labelRefs = new Uint32Array(n);
  const labelClasses = new Uint8Array(n);
  const hasNodeAlphas = model.nodeAlphas !== undefined;
  const nodeAlphas = hasNodeAlphas ? new Float32Array(n) : undefined;

  for (const [oldIndex, newIndex] of oldToNew) {
    nodeRects[4 * newIndex] = model.nodeRects[4 * oldIndex]!;
    nodeRects[4 * newIndex + 1] = model.nodeRects[4 * oldIndex + 1]!;
    nodeRects[4 * newIndex + 2] = model.nodeRects[4 * oldIndex + 2]!;
    nodeRects[4 * newIndex + 3] = model.nodeRects[4 * oldIndex + 3]!;
    nodeColorIds[newIndex] = model.nodeColorIds[oldIndex]!;
    nodeFlags[newIndex] = model.nodeFlags[oldIndex]!;
    nodeCoveredLeaves[newIndex] = model.nodeCoveredLeaves[oldIndex]!;
    labelRefs[newIndex] = model.labelRefs[oldIndex]!;
    labelClasses[newIndex] = model.labelClasses[oldIndex]!;
    if (nodeAlphas !== undefined) nodeAlphas[newIndex] = model.nodeAlphas![oldIndex]!;
  }

  // ---- edges: keep only those with both endpoints surviving ---------------
  const keptEdges: number[] = [];
  for (let e = 0; e < model.edgeKeys.length; e++) {
    const src = model.edgeIndices[2 * e]!;
    const dst = model.edgeIndices[2 * e + 1]!;
    if (oldToNew.has(src) && oldToNew.has(dst)) keptEdges.push(e);
  }
  const m = keptEdges.length;

  const edgeKeys: string[] = [];
  const edgeIndices = new Uint32Array(2 * m);
  const edgeColorIds = new Uint16Array(m);
  const edgeWeights = new Float64Array(m);
  const edgeMultiplicities = new Uint32Array(m);
  const edgeFlags = new Uint8Array(m);
  const edgeRouteOffsets = new Uint32Array(m + 1);
  const hasEdgeAlphas = model.edgeAlphas !== undefined;
  const edgeAlphas = hasEdgeAlphas ? new Float32Array(m) : undefined;
  const routeLanes: number[] = [];

  for (let ne = 0; ne < m; ne++) {
    const oldE = keptEdges[ne]!;
    const newSrc = oldToNew.get(model.edgeIndices[2 * oldE]!)!;
    const newDst = oldToNew.get(model.edgeIndices[2 * oldE + 1]!)!;
    edgeKeys.push(model.edgeKeys[oldE]!);
    edgeIndices[2 * ne] = newSrc;
    edgeIndices[2 * ne + 1] = newDst;
    edgeColorIds[ne] = model.edgeColorIds[oldE]!;
    edgeWeights[ne] = model.edgeWeights[oldE]!;
    edgeMultiplicities[ne] = model.edgeMultiplicities[oldE]!;
    edgeFlags[ne] = model.edgeFlags[oldE]!;
    if (edgeAlphas !== undefined) edgeAlphas[ne] = model.edgeAlphas![oldE]!;

    // Degree recomputation over surviving edges.
    nodeDegrees[newSrc] = nodeDegrees[newSrc]! + 1;
    nodeDegrees[newDst] = nodeDegrees[newDst]! + 1;

    edgeRouteOffsets[ne] = routeLanes.length / 2;
    const start = model.edgeRouteOffsets[oldE]!;
    const end = model.edgeRouteOffsets[oldE + 1]!;
    for (let p = start; p < end; p++) {
      routeLanes.push(model.edgeRoutePoints[2 * p]!, model.edgeRoutePoints[2 * p + 1]!);
    }
  }
  edgeRouteOffsets[m] = routeLanes.length / 2;

  return {
    revision: `${model.revision}~ev${n}`,
    bounds: model.bounds,
    nodeIds: keptNodeIds,
    nodeRects,
    nodeColorKeys: model.nodeColorKeys,
    nodeColorIds,
    nodeFlags,
    nodeCoveredLeaves,
    nodeDegrees,
    labelTable: model.labelTable,
    labelRefs,
    labelClasses,
    ...(nodeAlphas !== undefined ? { nodeAlphas } : {}),
    edgeKeys,
    edgeIndices,
    edgeColorKeys: model.edgeColorKeys,
    edgeColorIds,
    edgeWeights,
    edgeMultiplicities,
    edgeFlags,
    edgeRouteOffsets,
    edgeRoutePoints: Float64Array.from(routeLanes),
    ...(edgeAlphas !== undefined ? { edgeAlphas } : {}),
    diagnostics: model.diagnostics,
  };
}
