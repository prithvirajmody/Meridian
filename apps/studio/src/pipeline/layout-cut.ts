/**
 * One cut → one layout, the same way for boot and for every 6D transition:
 * deterministic sizes from labels, ADR-0018 provider choice, compound nesting
 * for the layered provider. Extracted from `StudioSession` so the navigator's
 * transition pipeline and the boot pipeline are literally the same code path.
 */
import type { LodResult } from '@meridian/abstraction';
import {
  buildContainmentIndex,
  containmentPathOf,
  type GraphSpace,
  type NodeId,
  type SemanticNode,
} from '@meridian/graph-core';
import { chooseProvider, type CompoundNesting, type LayoutInput, type LayoutResult, type Size } from '@meridian/layout';

export interface StudioLayoutService {
  compute(providerId: string, input: LayoutInput, prev?: LayoutResult): Promise<LayoutResult>;
  dispose(): void | Promise<void>;
}

export function nodeSize(label: string): Size {
  return {
    width: Math.max(72, Math.min(260, 24 + Array.from(label).length * 7)),
    height: 34,
  };
}

export function indexNodes(space: GraphSpace): ReadonlyMap<NodeId, SemanticNode> {
  const result = new Map<NodeId, SemanticNode>();
  for (const graph of space.graphs.values()) {
    for (const node of graph.nodes.values()) result.set(node.id, node);
  }
  return result;
}

export function buildCompound(space: GraphSpace, lod: LodResult): CompoundNesting {
  const containment = buildContainmentIndex(space);
  const groupOf = new Map<NodeId, string>();
  const parentOf = new Map<string, string>();
  for (const id of lod.cut.members) {
    const graph = lod.cut.trace.get(id)?.graph;
    if (graph === undefined) continue;
    groupOf.set(id, graph);
    const path = containmentPathOf(space, graph, containment);
    for (let index = 1; index < path.length; index++) {
      parentOf.set(path[index]!, path[index - 1]!);
    }
  }
  return { groupOf, parentOf };
}

export interface CutLayout {
  readonly providerId: string;
  readonly layout: LayoutResult;
}

/** Lay out one resolved cut. `prev` is the outgoing layout (ADR-0016 warm
 * start) so transition targets stay stable under zoom. */
export async function layoutForLod(
  space: GraphSpace,
  lod: LodResult,
  service: StudioLayoutService,
  prev?: LayoutResult,
): Promise<CutLayout> {
  const nodes = indexNodes(space);
  const sizes = new Map<NodeId, Size>();
  for (const id of lod.cut.members) sizes.set(id, nodeSize(nodes.get(id)?.label ?? String(id)));
  const providerId = chooseProvider(lod.cut, lod.inducedEdges);
  const compound = providerId === 'elk-layered' ? buildCompound(space, lod) : undefined;
  const input: LayoutInput = {
    cut: lod.cut,
    edges: lod.inducedEdges,
    sizes,
    hints: {},
    ...(compound !== undefined ? { compound } : {}),
  };
  const layout = await service.compute(providerId, input, prev);
  return { providerId, layout };
}
