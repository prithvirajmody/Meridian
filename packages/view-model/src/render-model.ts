/**
 * Pure snapshot + LOD + layout + selection → flat RenderModel (ADR-A8/0022).
 * No DOM, Pixi, logging, store access, or object-graph output crosses this
 * boundary. Typed-array contents are treated as immutable by contract.
 */
import type { InducedEdge, LodResult } from '@meridian/abstraction';
import type { GraphSpace, NodeId, SemanticNode } from '@meridian/graph-core';
import type { Point, Rect } from './coords.js';
import type { LayoutResult } from './layout-types.js';
import {
  LABEL_CLASS_CONNECTED,
  LABEL_CLASS_FORCED,
  LABEL_CLASS_ORDINARY,
  LABEL_CLASS_SUMMARY,
  type LabelClass,
} from './labels.js';

export const NODE_FLAG_SELECTED = 1 << 0;
export const NODE_FLAG_SELECTION_ANCHOR = 1 << 1;
export const NODE_FLAG_HAS_DETAIL = 1 << 2;
export const EDGE_FLAG_SELECTED = 1 << 0;
export const EDGE_FLAG_SELECTION_ANCHOR = 1 << 1;

export type SelectionAnchor =
  | { readonly kind: 'node'; readonly id: NodeId }
  | { readonly kind: 'edge'; readonly key: string };

/** Serializable set semantics: duplicates are ignored by the builder. */
export interface SelectionState {
  readonly nodes: readonly NodeId[];
  readonly edges: readonly string[];
  readonly anchor?: SelectionAnchor;
}

/** Projection-neutral shorthand; exactly the existing selection contract. */
export type Selection = SelectionState;

export const EMPTY_SELECTION: SelectionState = { nodes: [], edges: [] };

export type RenderDiagnosticCode =
  | 'missing-node'
  | 'missing-position'
  | 'non-finite-position'
  | 'negative-size'
  | 'missing-edge-endpoint'
  | 'non-finite-edge-weight'
  | 'invalid-edge-multiplicity'
  | 'non-finite-route';

/** A located repair/warning. Diagnostics are returned as data, never logged. */
export interface RenderDiagnostic {
  readonly code: RenderDiagnosticCode;
  readonly element: 'node' | 'edge';
  readonly id: string;
  readonly field: string;
  readonly received: string;
}

/**
 * Flat, structured-cloneable renderer input. String tables provide identity;
 * numeric lanes are upload-friendly and ordered deterministically.
 */
export interface RenderModel {
  readonly revision: string;
  readonly bounds: Rect;

  readonly nodeIds: readonly NodeId[];
  /** `[x,y,width,height]` per node, float64 world truth. */
  readonly nodeRects: Float64Array;
  readonly nodeColorKeys: readonly string[];
  readonly nodeColorIds: Uint16Array;
  readonly nodeFlags: Uint8Array;
  readonly nodeCoveredLeaves: Float64Array;
  readonly nodeDegrees: Uint32Array;

  readonly labelTable: readonly string[];
  readonly labelRefs: Uint32Array;
  readonly labelClasses: Uint8Array;

  /**
   * Optional per-node opacity lane `[0,1]`, one entry per node (ADR-0023:
   * entering nodes fade in, exiting nodes fade out, crossfades blend whole
   * frames). Absent ⇒ fully opaque. `buildRenderModel` never emits it — only
   * the Phase 6 transition player constructs transient models carrying alphas;
   * a settled model is always fully opaque.
   */
  readonly nodeAlphas?: Float32Array;
  /** Optional per-edge opacity lane `[0,1]` (ADR-0023). Absent ⇒ opaque. */
  readonly edgeAlphas?: Float32Array;

  readonly edgeKeys: readonly string[];
  /** `[srcNodeIndex,dstNodeIndex]` per edge. */
  readonly edgeIndices: Uint32Array;
  readonly edgeColorKeys: readonly string[];
  readonly edgeColorIds: Uint16Array;
  readonly edgeWeights: Float64Array;
  readonly edgeMultiplicities: Uint32Array;
  readonly edgeFlags: Uint8Array;
  /** CSR offsets into `edgeRoutePoints`, measured in points rather than lanes. */
  readonly edgeRouteOffsets: Uint32Array;
  /** `[x,y]` per routed point. Empty spans mean straight center-to-center. */
  readonly edgeRoutePoints: Float64Array;

  readonly diagnostics: readonly RenderDiagnostic[];
}

interface IndexedNode {
  readonly id: NodeId;
  readonly node: SemanticNode | undefined;
}

function compareString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function edgeKey(edge: InducedEdge): string {
  return `${edge.src}→${edge.dst}→${edge.kind}`;
}

function compareEdge(a: InducedEdge, b: InducedEdge): number {
  return compareString(a.src, b.src) || compareString(a.dst, b.dst) || compareString(a.kind, b.kind);
}

function semanticNodes(snapshot: GraphSpace): ReadonlyMap<NodeId, SemanticNode> {
  const result = new Map<NodeId, SemanticNode>();
  const graphIds = [...snapshot.graphs.keys()].sort(compareString);
  for (const graphId of graphIds) {
    const graph = snapshot.graphs.get(graphId)!;
    const ids = [...graph.nodes.keys()].sort(compareString);
    for (const id of ids) if (!result.has(id)) result.set(id, graph.nodes.get(id)!);
  }
  return result;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareString);
}

function indexTable(values: readonly string[]): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  values.forEach((value, index) => result.set(value, index));
  return result;
}

function received(value: number | undefined): string {
  if (value === undefined) return 'missing';
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return 'Infinity';
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
  return String(value);
}

function repairCoordinate(
  value: number,
  nodeId: NodeId,
  field: 'x' | 'y' | 'width' | 'height',
  diagnostics: RenderDiagnostic[],
): number {
  if (!Number.isFinite(value)) {
    diagnostics.push({
      code: 'non-finite-position',
      element: 'node',
      id: nodeId,
      field,
      received: received(value),
    });
    return 0;
  }
  if ((field === 'width' || field === 'height') && value < 0) {
    diagnostics.push({
      code: 'negative-size',
      element: 'node',
      id: nodeId,
      field,
      received: String(value),
    });
    return 0;
  }
  return Object.is(value, -0) ? 0 : value;
}

function repairRect(
  nodeId: NodeId,
  rect: Rect | undefined,
  diagnostics: RenderDiagnostic[],
): Rect {
  if (rect === undefined) {
    diagnostics.push({
      code: 'missing-position',
      element: 'node',
      id: nodeId,
      field: 'rect',
      received: 'missing',
    });
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  return {
    x: repairCoordinate(rect.x, nodeId, 'x', diagnostics),
    y: repairCoordinate(rect.y, nodeId, 'y', diagnostics),
    width: repairCoordinate(rect.width, nodeId, 'width', diagnostics),
    height: repairCoordinate(rect.height, nodeId, 'height', diagnostics),
  };
}

function finiteNonNegative(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

class BoundsAccumulator {
  private minX = Infinity;
  private minY = Infinity;
  private maxX = -Infinity;
  private maxY = -Infinity;
  private saw = false;

  point(point: Point): void {
    this.saw = true;
    this.minX = Math.min(this.minX, point.x);
    this.minY = Math.min(this.minY, point.y);
    this.maxX = Math.max(this.maxX, point.x);
    this.maxY = Math.max(this.maxY, point.y);
  }

  rect(rect: Rect): void {
    this.point({ x: rect.x, y: rect.y });
    this.point({ x: rect.x + rect.width, y: rect.y + rect.height });
  }

  result(): Rect {
    if (!this.saw) return { x: 0, y: 0, width: 0, height: 0 };
    return {
      x: this.minX,
      y: this.minY,
      width: this.maxX - this.minX,
      height: this.maxY - this.minY,
    };
  }
}

class RevisionHash {
  private value = 0x811c9dc5;
  private readonly numberBuffer = new ArrayBuffer(8);
  private readonly numberView = new DataView(this.numberBuffer);

  private byte(value: number): void {
    this.value ^= value;
    this.value = Math.imul(this.value, 0x01000193);
  }

  number(value: number): void {
    this.numberView.setFloat64(0, value, true);
    for (let i = 0; i < 8; i++) this.byte(this.numberView.getUint8(i));
  }

  string(value: string): void {
    this.number(value.length);
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      this.byte(code & 0xff);
      this.byte(code >>> 8);
    }
  }

  numbers(values: ArrayLike<number>): void {
    this.number(values.length);
    for (let i = 0; i < values.length; i++) this.number(values[i]!);
  }

  strings(values: readonly string[]): void {
    this.number(values.length);
    for (const value of values) this.string(value);
  }

  digest(): string {
    return `rm-${(this.value >>> 0).toString(16).padStart(8, '0')}`;
  }
}

interface RevisionParts {
  readonly bounds: Rect;
  readonly nodeIds: readonly NodeId[];
  readonly nodeRects: Float64Array;
  readonly nodeColorKeys: readonly string[];
  readonly nodeColorIds: Uint16Array;
  readonly nodeFlags: Uint8Array;
  readonly nodeCoveredLeaves: Float64Array;
  readonly nodeDegrees: Uint32Array;
  readonly labelTable: readonly string[];
  readonly labelRefs: Uint32Array;
  readonly labelClasses: Uint8Array;
  readonly edgeKeys: readonly string[];
  readonly edgeIndices: Uint32Array;
  readonly edgeColorKeys: readonly string[];
  readonly edgeColorIds: Uint16Array;
  readonly edgeWeights: Float64Array;
  readonly edgeMultiplicities: Uint32Array;
  readonly edgeFlags: Uint8Array;
  readonly edgeRouteOffsets: Uint32Array;
  readonly edgeRoutePoints: Float64Array;
  readonly diagnostics: readonly RenderDiagnostic[];
}

function revisionOf(parts: RevisionParts): string {
  const hash = new RevisionHash();
  hash.number(parts.bounds.x);
  hash.number(parts.bounds.y);
  hash.number(parts.bounds.width);
  hash.number(parts.bounds.height);
  hash.strings(parts.nodeIds);
  hash.numbers(parts.nodeRects);
  hash.strings(parts.nodeColorKeys);
  hash.numbers(parts.nodeColorIds);
  hash.numbers(parts.nodeFlags);
  hash.numbers(parts.nodeCoveredLeaves);
  hash.numbers(parts.nodeDegrees);
  hash.strings(parts.labelTable);
  hash.numbers(parts.labelRefs);
  hash.numbers(parts.labelClasses);
  hash.strings(parts.edgeKeys);
  hash.numbers(parts.edgeIndices);
  hash.strings(parts.edgeColorKeys);
  hash.numbers(parts.edgeColorIds);
  hash.numbers(parts.edgeWeights);
  hash.numbers(parts.edgeMultiplicities);
  hash.numbers(parts.edgeFlags);
  hash.numbers(parts.edgeRouteOffsets);
  hash.numbers(parts.edgeRoutePoints);
  hash.number(parts.diagnostics.length);
  for (const diagnostic of parts.diagnostics) {
    hash.string(diagnostic.code);
    hash.string(diagnostic.element);
    hash.string(diagnostic.id);
    hash.string(diagnostic.field);
    hash.string(diagnostic.received);
  }
  return hash.digest();
}

/** Build the only value the renderer is allowed to read. */
export function buildRenderModel(
  snapshot: GraphSpace,
  lodResult: LodResult,
  layoutResult: LayoutResult,
  selection: SelectionState = EMPTY_SELECTION,
): RenderModel {
  const diagnostics: RenderDiagnostic[] = [];
  const nodesById = semanticNodes(snapshot);
  const nodeIds = [...lodResult.cut.members].sort(compareString);
  const indexedNodes: IndexedNode[] = nodeIds.map((id) => ({ id, node: nodesById.get(id) }));
  const nodeIndex = new Map<NodeId, number>();
  nodeIds.forEach((id, index) => nodeIndex.set(id, index));

  for (const { id, node } of indexedNodes) {
    if (node === undefined) {
      diagnostics.push({
        code: 'missing-node',
        element: 'node',
        id,
        field: 'snapshot',
        received: 'missing',
      });
    }
  }

  const sortedEdges = [...lodResult.inducedEdges].sort(compareEdge);
  const validEdges: InducedEdge[] = [];
  for (const edge of sortedEdges) {
    if (!nodeIndex.has(edge.src) || !nodeIndex.has(edge.dst)) {
      diagnostics.push({
        code: 'missing-edge-endpoint',
        element: 'edge',
        id: edgeKey(edge),
        field: !nodeIndex.has(edge.src) ? 'src' : 'dst',
        received: !nodeIndex.has(edge.src) ? edge.src : edge.dst,
      });
      continue;
    }
    validEdges.push(edge);
  }

  const nodeDegrees = new Uint32Array(nodeIds.length);
  for (const edge of validEdges) {
    const srcIndex = nodeIndex.get(edge.src)!;
    const dstIndex = nodeIndex.get(edge.dst)!;
    nodeDegrees[srcIndex] = nodeDegrees[srcIndex]! + 1;
    nodeDegrees[dstIndex] = nodeDegrees[dstIndex]! + 1;
  }

  const selectedNodes = new Set(selection.nodes);
  const selectedEdges = new Set(selection.edges);
  const anchor = selection.anchor;
  const nodeRects = new Float64Array(4 * nodeIds.length);
  const nodeFlags = new Uint8Array(nodeIds.length);
  const nodeCoveredLeaves = new Float64Array(nodeIds.length);
  const labelClasses = new Uint8Array(nodeIds.length);
  const bounds = new BoundsAccumulator();

  const labels = indexedNodes.map(({ id, node }) => (node?.label ?? id).normalize('NFC'));
  const labelTable = uniqueSorted(labels);
  const labelIndex = indexTable(labelTable);
  const labelRefs = new Uint32Array(nodeIds.length);

  const nodeKinds = indexedNodes.map(({ node }) => node?.kind ?? '');
  const nodeColorKeys = uniqueSorted(nodeKinds);
  const nodeColorIndex = indexTable(nodeColorKeys);
  if (nodeColorKeys.length > 0xffff) throw new RangeError('view-model: too many node color keys');
  const nodeColorIds = new Uint16Array(nodeIds.length);

  for (let i = 0; i < indexedNodes.length; i++) {
    const { id, node } = indexedNodes[i]!;
    const rect = repairRect(id, layoutResult.positions.get(id), diagnostics);
    nodeRects[4 * i] = rect.x;
    nodeRects[4 * i + 1] = rect.y;
    nodeRects[4 * i + 2] = rect.width;
    nodeRects[4 * i + 3] = rect.height;
    bounds.rect(rect);

    const selected = selectedNodes.has(id);
    const isAnchor = anchor?.kind === 'node' && anchor.id === id;
    nodeFlags[i] =
      (selected ? NODE_FLAG_SELECTED : 0) |
      (isAnchor ? NODE_FLAG_SELECTION_ANCHOR : 0) |
      (node?.detail !== undefined ? NODE_FLAG_HAS_DETAIL : 0);

    const trace = lodResult.cut.trace.get(id);
    const coveredLeaves = finiteNonNegative(trace?.coveredLeaves ?? 1, 1);
    nodeCoveredLeaves[i] = coveredLeaves;

    let labelClass: LabelClass;
    if (isAnchor) labelClass = LABEL_CLASS_FORCED;
    else if (coveredLeaves > 1 || node?.detail !== undefined) labelClass = LABEL_CLASS_SUMMARY;
    else if (nodeDegrees[i]! > 0) labelClass = LABEL_CLASS_CONNECTED;
    else labelClass = LABEL_CLASS_ORDINARY;
    if (selected && labelClass > LABEL_CLASS_SUMMARY) labelClass = LABEL_CLASS_SUMMARY;
    labelClasses[i] = labelClass;

    labelRefs[i] = labelIndex.get(labels[i]!)!;
    nodeColorIds[i] = nodeColorIndex.get(nodeKinds[i]!)!;
  }

  const edgeKeys = validEdges.map(edgeKey);
  const edgeIndices = new Uint32Array(2 * validEdges.length);
  const edgeKinds = validEdges.map((edge) => edge.kind);
  const edgeColorKeys = uniqueSorted(edgeKinds);
  const edgeColorIndex = indexTable(edgeColorKeys);
  if (edgeColorKeys.length > 0xffff) throw new RangeError('view-model: too many edge color keys');
  const edgeColorIds = new Uint16Array(validEdges.length);
  const edgeWeights = new Float64Array(validEdges.length);
  const edgeMultiplicities = new Uint32Array(validEdges.length);
  const edgeFlags = new Uint8Array(validEdges.length);
  const edgeRouteOffsets = new Uint32Array(validEdges.length + 1);
  const routeLanes: number[] = [];

  for (let i = 0; i < validEdges.length; i++) {
    const edge = validEdges[i]!;
    const key = edgeKeys[i]!;
    edgeIndices[2 * i] = nodeIndex.get(edge.src)!;
    edgeIndices[2 * i + 1] = nodeIndex.get(edge.dst)!;
    edgeColorIds[i] = edgeColorIndex.get(edge.kind)!;

    if (!Number.isFinite(edge.weight)) {
      diagnostics.push({
        code: 'non-finite-edge-weight',
        element: 'edge',
        id: key,
        field: 'weight',
        received: received(edge.weight),
      });
      edgeWeights[i] = 1;
    } else edgeWeights[i] = edge.weight;

    if (!Number.isInteger(edge.multiplicity) || edge.multiplicity < 0) {
      diagnostics.push({
        code: 'invalid-edge-multiplicity',
        element: 'edge',
        id: key,
        field: 'multiplicity',
        received: String(edge.multiplicity),
      });
      edgeMultiplicities[i] = 0;
    } else edgeMultiplicities[i] = edge.multiplicity;

    const selected = selectedEdges.has(key);
    const isAnchor = anchor?.kind === 'edge' && anchor.key === key;
    edgeFlags[i] =
      (selected ? EDGE_FLAG_SELECTED : 0) | (isAnchor ? EDGE_FLAG_SELECTION_ANCHOR : 0);

    edgeRouteOffsets[i] = routeLanes.length / 2;
    const route = layoutResult.edgeRoutes?.get(key);
    if (route !== undefined) {
      for (let pointIndex = 0; pointIndex < route.length; pointIndex++) {
        const source = route[pointIndex]!;
        let x = source.x;
        let y = source.y;
        if (!Number.isFinite(x)) {
          diagnostics.push({
            code: 'non-finite-route',
            element: 'edge',
            id: key,
            field: `route[${pointIndex}].x`,
            received: received(x),
          });
          x = 0;
        }
        if (!Number.isFinite(y)) {
          diagnostics.push({
            code: 'non-finite-route',
            element: 'edge',
            id: key,
            field: `route[${pointIndex}].y`,
            received: received(y),
          });
          y = 0;
        }
        x = Object.is(x, -0) ? 0 : x;
        y = Object.is(y, -0) ? 0 : y;
        routeLanes.push(x, y);
        bounds.point({ x, y });
      }
    }
    edgeRouteOffsets[i + 1] = routeLanes.length / 2;
  }

  const edgeRoutePoints = Float64Array.from(routeLanes);
  const modelParts: RevisionParts = {
    bounds: bounds.result(),
    nodeIds,
    nodeRects,
    nodeColorKeys,
    nodeColorIds,
    nodeFlags,
    nodeCoveredLeaves,
    nodeDegrees,
    labelTable,
    labelRefs,
    labelClasses,
    edgeKeys,
    edgeIndices,
    edgeColorKeys,
    edgeColorIds,
    edgeWeights,
    edgeMultiplicities,
    edgeFlags,
    edgeRouteOffsets,
    edgeRoutePoints,
    diagnostics,
  };

  return {
    revision: revisionOf(modelParts),
    ...modelParts,
  };
}
