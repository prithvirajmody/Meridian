import type { InducedEdge, LodResult } from '@meridian/abstraction';
import {
  asEdgeId,
  asGraphId,
  asNodeId,
  type GraphSpace,
  type NodeId,
  type SemanticNode,
} from '@meridian/graph-core';
import type { LayoutResult, Rect } from '../src/index.js';

const SOURCE = { origin: 'source' as const, uri: 'memory:test' };

export function n(id: string): NodeId {
  return asNodeId(id);
}

export function node(
  id: string,
  label: string,
  kind = 'test:item',
  detailGraph?: string,
): SemanticNode {
  return {
    id: n(id),
    label,
    kind,
    ...(detailGraph === undefined ? {} : { detail: { graph: asGraphId(detailGraph) } }),
    attrs: {},
    provenance: SOURCE,
  };
}

export function spaceOf(nodes: readonly SemanticNode[]): GraphSpace {
  const root = asGraphId('g-root');
  const graphs = new Map();
  graphs.set(root, {
    id: root,
    meta: { label: 'fixture', domain: 'test', provenance: SOURCE },
    nodes: new Map(nodes.map((value) => [value.id, value])),
    edges: new Map(),
  });
  for (const value of nodes) {
    if (value.detail === undefined || graphs.has(value.detail.graph)) continue;
    graphs.set(value.detail.graph, {
      id: value.detail.graph,
      meta: { label: 'detail', domain: 'test', provenance: SOURCE },
      nodes: new Map(),
      edges: new Map(),
    });
  }
  return { graphs, roots: [root] };
}

export function edge(src: string, dst: string, kind = 'test:rel'): InducedEdge {
  return {
    src: n(src),
    dst: n(dst),
    kind,
    weight: 2,
    multiplicity: 3,
    samples: [asEdgeId(`e-${src}-${dst}`)],
  };
}

export function lodOf(
  members: readonly string[],
  edges: readonly InducedEdge[] = [],
  coveredLeaves: Readonly<Record<string, number>> = {},
): LodResult {
  const ids = members.map(n);
  const trace = new Map(
    ids.map((id) => [
      id,
      {
        node: id,
        graph: asGraphId('g-root'),
        depth: 0,
        reason: 'level' as const,
        coveredLeaves: coveredLeaves[id] ?? 1,
      },
    ]),
  );
  return {
    cut: {
      level: 0,
      members: ids,
      trace,
      coverage: {
        leaves: [...trace.values()].reduce((sum, value) => sum + value.coveredLeaves, 0),
        coveredLeaves: [...trace.values()].reduce((sum, value) => sum + value.coveredLeaves, 0),
        covers: true,
      },
    },
    inducedEdges: edges,
    cappedEdges: { edges, residuals: [] },
    frontier: { expandable: [], collapsible: [], needsHydration: [] },
    provenance: {
      zoom: 0,
      nominalLevel: 0,
      level: 0,
      reasons: new Map(ids.map((id) => [id, 'level' as const])),
      ignoredOverrides: [],
    },
  };
}

export function layoutOf(
  positions: Readonly<Record<string, Rect>>,
  edgeRoutes?: ReadonlyMap<string, readonly { readonly x: number; readonly y: number }[]>,
): LayoutResult {
  return {
    positions: new Map(Object.entries(positions).map(([id, rect]) => [n(id), rect])),
    ...(edgeRoutes === undefined ? {} : { edgeRoutes }),
    bounds: { x: -999, y: -999, width: 1, height: 1 },
    stability: 1,
  };
}
