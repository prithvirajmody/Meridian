/**
 * Pure semantic cut model shared by every projection (ADR-0037).
 *
 * Filtering is deliberately absent: callers publish the already-filtered
 * GraphSpace/LodResult pair, and this builder copies that exact visible set.
 */
import type { CutReason, InducedEdge, LodResult } from '@meridian/abstraction';
import type {
  AttrBag,
  AttrValue,
  GraphId,
  GraphSpace,
  NodeId,
  SemanticNode,
} from '@meridian/graph-core';
import { createFocusState, type FocusState } from './focus.js';
import type { LayoutResult } from './layout-types.js';
import {
  buildRenderModel,
  EMPTY_SELECTION,
  type RenderModel,
  type SelectionState,
} from './render-model.js';

/** Domain-declared temporal vocabulary. Projections never hard-code a domain. */
export interface TemporalDomainHints {
  readonly startAttribute: string;
  readonly endAttribute?: string;
  readonly laneAttribute?: string;
}

/** Plain presentation metadata associated with the current domain. */
export interface DomainMeta {
  readonly domain: string;
  readonly label: string;
  readonly temporal?: TemporalDomainHints;
}

/** One visible member of the cut, with its available containment context. */
export interface ProjectionNode {
  readonly id: NodeId;
  /** Stable semantic forest path; independent of cut filtering and map order. */
  readonly orderPath: readonly number[];
  readonly label: string;
  readonly kind: string;
  readonly attrs: AttrBag;
  readonly graphId: GraphId | null;
  /** Node whose detail graph contains this node; null for a forest root. */
  readonly parentId: NodeId | null;
  readonly detailGraphId: GraphId | null;
  readonly depth: number | null;
  readonly cutReason: CutReason | null;
  readonly coveredLeaves: number;
}

/**
 * The structured-clone-safe presentation waist consumed by all projections.
 * Layout is optional; whenever it exists, renderModel is built by the single
 * established map path rather than re-derived by a projection.
 */
export interface ProjectionModel {
  readonly cutLevel: number;
  readonly nodes: readonly ProjectionNode[];
  readonly inducedEdges: readonly InducedEdge[];
  readonly selection: SelectionState;
  readonly focus: FocusState;
  readonly domainMeta: DomainMeta;
  readonly layout?: LayoutResult;
  readonly renderModel?: RenderModel;
}

export interface BuildProjectionModelOptions {
  readonly selection?: SelectionState;
  readonly focus?: FocusState;
  readonly domainMeta?: DomainMeta;
  readonly layout?: LayoutResult;
}

interface IndexedSemanticNode {
  readonly node: SemanticNode;
  readonly graphId: GraphId;
}

interface IndexOrderHint {
  readonly kind: 'index';
  readonly value: number;
  readonly attribute: string;
}

interface ProvenanceOrderHint {
  readonly kind: 'provenance';
  readonly uri: string | null;
  readonly span: readonly [number, number] | null;
}

type SemanticOrderHint = IndexOrderHint | ProvenanceOrderHint;

interface SiblingOrderKey {
  /** Explicit index, provenance, descendant hint, or NodeId-only fallback. */
  readonly tier: 0 | 1 | 2 | 3;
  readonly hint?: SemanticOrderHint;
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNullableString(left: string | null, right: string | null): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return compareString(left, right);
}

function compareNullableSpan(
  left: readonly [number, number] | null,
  right: readonly [number, number] | null,
): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return left[0] - right[0] || left[1] - right[1];
}

function compareOrderPath(left: readonly number[], right: readonly number[]): number {
  const common = Math.min(left.length, right.length);
  for (let index = 0; index < common; index++) {
    const compared = left[index]! - right[index]!;
    if (compared !== 0) return compared;
  }
  return left.length - right.length;
}

function cloneAttrValue(value: AttrValue): AttrValue {
  if (!Array.isArray(value)) return value;
  return [...value] as readonly string[] | readonly number[] | readonly boolean[];
}

function cloneAttrs(attrs: AttrBag): AttrBag {
  const copy: Record<string, AttrValue> = {};
  for (const key of Object.keys(attrs).sort(compareString)) copy[key] = cloneAttrValue(attrs[key]!);
  return copy;
}

function indexNodes(snapshot: GraphSpace): ReadonlyMap<NodeId, IndexedSemanticNode> {
  const indexed = new Map<NodeId, IndexedSemanticNode>();
  for (const graphId of [...snapshot.graphs.keys()].sort(compareString)) {
    const graph = snapshot.graphs.get(graphId)!;
    for (const nodeId of [...graph.nodes.keys()].sort(compareString)) {
      if (!indexed.has(nodeId)) indexed.set(nodeId, { node: graph.nodes.get(nodeId)!, graphId });
    }
  }
  return indexed;
}

function graphOwners(indexed: ReadonlyMap<NodeId, IndexedSemanticNode>): ReadonlyMap<GraphId, NodeId> {
  const owners = new Map<GraphId, NodeId>();
  for (const nodeId of [...indexed.keys()].sort(compareString)) {
    const detailGraphId = indexed.get(nodeId)!.node.detail?.graph;
    if (detailGraphId !== undefined && !owners.has(detailGraphId)) owners.set(detailGraphId, nodeId);
  }
  return owners;
}

function localName(key: string): string {
  const separator = key.lastIndexOf(':');
  return separator === -1 ? key : key.slice(separator + 1);
}

function explicitIndexHint(node: SemanticNode): IndexOrderHint | undefined {
  const candidates = Object.keys(node.attrs)
    .filter((key) => localName(key) === 'index')
    .flatMap((attribute): readonly IndexOrderHint[] => {
      const value = node.attrs[attribute];
      return typeof value === 'number' && Number.isFinite(value)
        ? [{ kind: 'index', value: Object.is(value, -0) ? 0 : value, attribute }]
        : [];
    })
    .sort(
      (left, right) =>
        left.value - right.value || compareString(left.attribute, right.attribute),
    );
  return candidates[0];
}

function provenanceHint(node: SemanticNode): ProvenanceOrderHint | undefined {
  const { uri, span } = node.provenance;
  if (uri === undefined && span === undefined) return undefined;
  return {
    kind: 'provenance',
    uri: uri ?? null,
    span: span === undefined ? null : [span[0], span[1]],
  };
}

function compareSemanticHint(left: SemanticOrderHint, right: SemanticOrderHint): number {
  if (left.kind !== right.kind) return left.kind === 'index' ? -1 : 1;
  if (left.kind === 'index' && right.kind === 'index') {
    return left.value - right.value || compareString(left.attribute, right.attribute);
  }
  if (left.kind === 'provenance' && right.kind === 'provenance') {
    return (
      compareNullableString(left.uri, right.uri) || compareNullableSpan(left.span, right.span)
    );
  }
  return 0;
}

function minimumHint(
  left: SemanticOrderHint | undefined,
  right: SemanticOrderHint | undefined,
): SemanticOrderHint | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return compareSemanticHint(left, right) <= 0 ? left : right;
}

/**
 * Build full-hierarchy paths once, before applying the cut. This is what makes
 * a surviving node retain the same path when a view predicate removes peers.
 */
function deriveOrderPaths(
  snapshot: GraphSpace,
  indexed: ReadonlyMap<NodeId, IndexedSemanticNode>,
  owners: ReadonlyMap<GraphId, NodeId>,
): ReadonlyMap<NodeId, readonly number[]> {
  const descendantHintCache = new Map<NodeId, SemanticOrderHint | undefined>();
  const descendantHintVisiting = new Set<NodeId>();

  const descendantHint = (nodeId: NodeId): SemanticOrderHint | undefined => {
    if (descendantHintCache.has(nodeId)) return descendantHintCache.get(nodeId);
    if (descendantHintVisiting.has(nodeId)) return undefined;
    descendantHintVisiting.add(nodeId);
    const detailGraphId = indexed.get(nodeId)?.node.detail?.graph;
    const graph = detailGraphId === undefined ? undefined : snapshot.graphs.get(detailGraphId);
    let result: SemanticOrderHint | undefined;
    if (graph !== undefined) {
      for (const childId of [...graph.nodes.keys()].sort(compareString)) {
        const child = graph.nodes.get(childId)!;
        result = minimumHint(result, explicitIndexHint(child));
        result = minimumHint(result, provenanceHint(child));
        result = minimumHint(result, descendantHint(childId));
      }
    }
    descendantHintVisiting.delete(nodeId);
    descendantHintCache.set(nodeId, result);
    return result;
  };

  const siblingKey = (node: SemanticNode): SiblingOrderKey => {
    const indexHint = explicitIndexHint(node);
    if (indexHint !== undefined) return { tier: 0, hint: indexHint };
    const sourceHint = provenanceHint(node);
    if (sourceHint !== undefined) return { tier: 1, hint: sourceHint };
    const inheritedHint = descendantHint(node.id);
    return inheritedHint === undefined ? { tier: 3 } : { tier: 2, hint: inheritedHint };
  };

  const siblingOrdinals = new Map<NodeId, number>();
  for (const graphId of [...snapshot.graphs.keys()].sort(compareString)) {
    const graph = snapshot.graphs.get(graphId)!;
    const ordered = [...graph.nodes.values()].sort((left, right) => {
      const leftKey = siblingKey(left);
      const rightKey = siblingKey(right);
      if (leftKey.tier !== rightKey.tier) return leftKey.tier - rightKey.tier;
      const hintComparison =
        leftKey.hint === undefined || rightKey.hint === undefined
          ? 0
          : compareSemanticHint(leftKey.hint, rightKey.hint);
      return hintComparison || compareString(left.id, right.id);
    });
    ordered.forEach((node, ordinal) => siblingOrdinals.set(node.id, ordinal));
  }

  const rootGraphIds = [...snapshot.graphs.keys()]
    .filter((graphId) => !owners.has(graphId))
    .sort(compareString);
  const rootOrdinals = new Map(rootGraphIds.map((graphId, ordinal) => [graphId, ordinal] as const));
  const allGraphOrdinals = new Map(
    [...snapshot.graphs.keys()]
      .sort(compareString)
      .map((graphId, ordinal) => [graphId, ordinal] as const),
  );
  const nodePaths = new Map<NodeId, readonly number[]>();
  const visiting = new Set<NodeId>();

  const nodePath = (nodeId: NodeId): readonly number[] => {
    const cached = nodePaths.get(nodeId);
    if (cached !== undefined) return cached;
    const indexedNode = indexed.get(nodeId);
    if (indexedNode === undefined || visiting.has(nodeId)) {
      return [rootGraphIds.length + snapshot.graphs.size];
    }
    visiting.add(nodeId);
    const ownerId = owners.get(indexedNode.graphId);
    const graphPath =
      ownerId === undefined
        ? [
            rootOrdinals.get(indexedNode.graphId) ??
              rootGraphIds.length + (allGraphOrdinals.get(indexedNode.graphId) ?? 0),
          ]
        : [...nodePath(ownerId)];
    const result = [...graphPath, siblingOrdinals.get(nodeId) ?? 0];
    visiting.delete(nodeId);
    nodePaths.set(nodeId, result);
    return result;
  };

  for (const nodeId of [...indexed.keys()].sort(compareString)) nodePath(nodeId);
  return nodePaths;
}

function cloneSelection(selection: SelectionState): SelectionState {
  return {
    nodes: [...selection.nodes],
    edges: [...selection.edges],
    ...(selection.anchor === undefined
      ? {}
      : selection.anchor.kind === 'node'
        ? { anchor: { kind: 'node' as const, id: selection.anchor.id } }
        : { anchor: { kind: 'edge' as const, key: selection.anchor.key } }),
  };
}

function cloneDomainMeta(meta: DomainMeta): DomainMeta {
  return {
    domain: meta.domain,
    label: meta.label,
    ...(meta.temporal === undefined
      ? {}
      : {
          temporal: {
            startAttribute: meta.temporal.startAttribute,
            ...(meta.temporal.endAttribute === undefined
              ? {}
              : { endAttribute: meta.temporal.endAttribute }),
            ...(meta.temporal.laneAttribute === undefined
              ? {}
              : { laneAttribute: meta.temporal.laneAttribute }),
          },
        }),
  };
}

function deriveDomainMeta(snapshot: GraphSpace): DomainMeta {
  const candidateIds = [...snapshot.roots, ...snapshot.graphs.keys()];
  const graphId = [...new Set(candidateIds)].sort(compareString).find((id) => snapshot.graphs.has(id));
  const graph = graphId === undefined ? undefined : snapshot.graphs.get(graphId);
  return {
    domain: graph?.meta.domain ?? '',
    label: graph?.meta.label ?? '',
  };
}

function cloneLayout(layout: LayoutResult): LayoutResult {
  const positions = new Map(
    [...layout.positions.entries()]
      .sort(([left], [right]) => compareString(left, right))
      .map(([id, rect]) => [id, { ...rect }] as const),
  );
  const edgeRoutes =
    layout.edgeRoutes === undefined
      ? undefined
      : new Map(
          [...layout.edgeRoutes.entries()]
            .sort(([left], [right]) => compareString(left, right))
            .map(([key, route]) => [key, route.map((point) => ({ ...point }))] as const),
        );
  return {
    positions,
    ...(edgeRoutes === undefined ? {} : { edgeRoutes }),
    bounds: { ...layout.bounds },
    stability: layout.stability,
  };
}

function cloneInducedEdge(edge: InducedEdge): InducedEdge {
  return {
    src: edge.src,
    dst: edge.dst,
    kind: edge.kind,
    weight: edge.weight,
    multiplicity: edge.multiplicity,
    samples: [...edge.samples],
  };
}

/** Build a neutral projection model from the exact caller-provided cut. */
export function buildProjectionModel(
  snapshot: GraphSpace,
  lodResult: LodResult,
  options: BuildProjectionModelOptions = {},
): ProjectionModel {
  const indexed = indexNodes(snapshot);
  const owners = graphOwners(indexed);
  const orderPaths = deriveOrderPaths(snapshot, indexed, owners);
  const selection = cloneSelection(options.selection ?? EMPTY_SELECTION);
  const focus = createFocusState(options.focus?.node);
  const domainMeta = cloneDomainMeta(options.domainMeta ?? deriveDomainMeta(snapshot));
  const unknownPath = [snapshot.graphs.size + 1] as const;
  const nodes = [...lodResult.cut.members]
    .sort(
      (left, right) =>
        compareOrderPath(orderPaths.get(left) ?? unknownPath, orderPaths.get(right) ?? unknownPath) ||
        compareString(left, right),
    )
    .map((id): ProjectionNode => {
      const indexedNode = indexed.get(id);
      const trace = lodResult.cut.trace.get(id);
      const graphId = trace?.graph ?? indexedNode?.graphId ?? null;
      return {
        id,
        orderPath: [...(orderPaths.get(id) ?? unknownPath)],
        label: indexedNode?.node.label ?? id,
        kind: indexedNode?.node.kind ?? '',
        attrs: cloneAttrs(indexedNode?.node.attrs ?? {}),
        graphId,
        parentId: graphId === null ? null : (owners.get(graphId) ?? null),
        detailGraphId: indexedNode?.node.detail?.graph ?? null,
        depth: trace?.depth ?? null,
        cutReason: trace?.reason ?? null,
        coveredLeaves: trace?.coveredLeaves ?? 1,
      };
    });
  const inducedEdges = [...lodResult.inducedEdges]
    .sort(
      (left, right) =>
        compareString(left.src, right.src) ||
        compareString(left.dst, right.dst) ||
        compareString(left.kind, right.kind),
    )
    .map(cloneInducedEdge);

  if (options.layout === undefined) {
    return {
      cutLevel: lodResult.cut.level,
      nodes,
      inducedEdges,
      selection,
      focus,
      domainMeta,
    };
  }

  return {
    cutLevel: lodResult.cut.level,
    nodes,
    inducedEdges,
    selection,
    focus,
    domainMeta,
    layout: cloneLayout(options.layout),
    renderModel: buildRenderModel(snapshot, lodResult, options.layout, selection),
  };
}
