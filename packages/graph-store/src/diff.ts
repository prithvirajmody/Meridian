/**
 * diffSpaces (ROADMAP Phase 1 §6): a state-diff producing an op delta that
 * replays a → b, for adapters that cannot emit ops natively. Correctness
 * over minimality; deterministic output (sorted at every stage, I6).
 *
 * Op ordering is what makes the delta applicable at every intermediate step:
 *   remove phase: edge:remove → node:detail clears → node:remove → graph:remove
 *   add phase:    graph:add → graph:meta → node:add → node:detail sets
 *                 → node:attr → edge:add
 * Clearing all changing claims before setting new ones avoids transient
 * double-claims (U3); containment subsets of a forest stay forests (U2).
 */
import type {
  AttrValue,
  EdgeId,
  GraphId,
  GraphSpace,
  NodeId,
  SemanticEdge,
  SemanticGraph,
  SemanticNode,
} from '@meridian/graph-core';
import type { GraphDeltaInput, GraphOpInput, OpOrigin } from './ops.js';
import { deepEqual } from './payload.js';

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function sortedIds<T>(map: ReadonlyMap<string, T>): string[] {
  return [...map.keys()].sort(byString);
}

/** Core identity: differing kind/label/provenance forces remove + re-add. */
function coreChanged(a: SemanticNode, b: SemanticNode): boolean {
  return a.kind !== b.kind || a.label !== b.label || !deepEqual(a.provenance, b.provenance);
}

function edgeChanged(a: SemanticEdge, b: SemanticEdge): boolean {
  return (
    a.src !== b.src ||
    a.dst !== b.dst ||
    a.kind !== b.kind ||
    a.weight !== b.weight ||
    !deepEqual(a.attrs, b.attrs) ||
    !deepEqual(a.provenance, b.provenance)
  );
}

export function diffSpaces(a: GraphSpace, b: GraphSpace, origin?: OpOrigin): GraphDeltaInput {
  const edgeRemoves: GraphOpInput[] = [];
  const detailClears: GraphOpInput[] = [];
  const nodeRemoves: GraphOpInput[] = [];
  const graphRemoves: GraphOpInput[] = [];
  const graphAdds: GraphOpInput[] = [];
  const graphMetas: GraphOpInput[] = [];
  const nodeAdds: GraphOpInput[] = [];
  const detailSets: GraphOpInput[] = [];
  const attrSets: GraphOpInput[] = [];
  const edgeAdds: GraphOpInput[] = [];

  const graphIds = [...new Set([...a.graphs.keys(), ...b.graphs.keys()])].sort(byString);

  for (const graphId of graphIds) {
    const ga = a.graphs.get(graphId);
    const gb = b.graphs.get(graphId);
    if (ga && !gb) {
      diffRemovedGraph(graphId, ga, edgeRemoves, nodeRemoves, graphRemoves);
    } else if (!ga && gb) {
      graphAdds.push({ t: 'graph:add', graph: graphId, meta: gb.meta });
      for (const nodeId of sortedIds(gb.nodes)) {
        nodeAdds.push({ t: 'node:add', graph: graphId, node: gb.nodes.get(nodeId as NodeId)! });
      }
      for (const edgeId of sortedIds(gb.edges)) {
        edgeAdds.push({ t: 'edge:add', graph: graphId, edge: gb.edges.get(edgeId as EdgeId)! });
      }
    } else if (ga && gb) {
      diffSharedGraph(graphId, ga, gb, {
        edgeRemoves,
        detailClears,
        nodeRemoves,
        graphMetas,
        nodeAdds,
        detailSets,
        attrSets,
        edgeAdds,
      });
    }
  }

  return {
    origin: origin ?? { actor: 'diff' },
    ops: [
      ...edgeRemoves,
      ...detailClears,
      ...nodeRemoves,
      ...graphRemoves,
      ...graphAdds,
      ...graphMetas,
      ...nodeAdds,
      ...detailSets,
      ...attrSets,
      ...edgeAdds,
    ],
  };
}

function diffRemovedGraph(
  graphId: GraphId,
  ga: SemanticGraph,
  edgeRemoves: GraphOpInput[],
  nodeRemoves: GraphOpInput[],
  graphRemoves: GraphOpInput[],
): void {
  for (const edgeId of sortedIds(ga.edges)) {
    edgeRemoves.push({ t: 'edge:remove', graph: graphId, id: edgeId as EdgeId, prev: ga.edges.get(edgeId as EdgeId)! });
  }
  for (const nodeId of sortedIds(ga.nodes)) {
    nodeRemoves.push({
      t: 'node:remove',
      graph: graphId,
      id: nodeId as NodeId,
      prev: ga.nodes.get(nodeId as NodeId)!,
    });
  }
  graphRemoves.push({ t: 'graph:remove', graph: graphId, prev: ga.meta });
}

interface SharedBuckets {
  edgeRemoves: GraphOpInput[];
  detailClears: GraphOpInput[];
  nodeRemoves: GraphOpInput[];
  graphMetas: GraphOpInput[];
  nodeAdds: GraphOpInput[];
  detailSets: GraphOpInput[];
  attrSets: GraphOpInput[];
  edgeAdds: GraphOpInput[];
}

function diffSharedGraph(
  graphId: GraphId,
  ga: SemanticGraph,
  gb: SemanticGraph,
  out: SharedBuckets,
): void {
  if (!deepEqual(ga.meta, gb.meta)) {
    out.graphMetas.push({ t: 'graph:meta', graph: graphId, prev: ga.meta, next: gb.meta });
  }

  // Nodes: classify. Re-added = same id, changed core identity fields.
  const reAdded = new Set<NodeId>();
  const nodeIds = [...new Set([...ga.nodes.keys(), ...gb.nodes.keys()])].sort(byString) as NodeId[];
  for (const id of nodeIds) {
    const na = ga.nodes.get(id);
    const nb = gb.nodes.get(id);
    if (na && !nb) {
      // A held claim dissolves with the node; nothing to clear explicitly.
      out.nodeRemoves.push({ t: 'node:remove', graph: graphId, id, prev: na });
    } else if (!na && nb) {
      out.nodeAdds.push({ t: 'node:add', graph: graphId, node: nb });
    } else if (na && nb) {
      if (coreChanged(na, nb)) {
        reAdded.add(id);
        out.nodeRemoves.push({ t: 'node:remove', graph: graphId, id, prev: na });
        out.nodeAdds.push({ t: 'node:add', graph: graphId, node: nb });
      } else {
        if (na.detail?.graph !== nb.detail?.graph) {
          if (na.detail) {
            out.detailClears.push({ t: 'node:detail', graph: graphId, id, prev: na.detail });
          }
          if (nb.detail) {
            out.detailSets.push({ t: 'node:detail', graph: graphId, id, next: nb.detail });
          }
        }
        diffAttrs(graphId, id, na, nb, out.attrSets);
      }
    }
  }

  // Edges: removed/changed/incident-to-re-added get removed; the latter two
  // classes get (re-)added afterwards.
  const edgeIds = [...new Set([...ga.edges.keys(), ...gb.edges.keys()])].sort(byString);
  for (const id of edgeIds) {
    const eaEdge = ga.edges.get(id as EdgeId);
    const ebEdge = gb.edges.get(id as EdgeId);
    if (eaEdge && !ebEdge) {
      out.edgeRemoves.push({ t: 'edge:remove', graph: graphId, id: id as EdgeId, prev: eaEdge });
    } else if (!eaEdge && ebEdge) {
      out.edgeAdds.push({ t: 'edge:add', graph: graphId, edge: ebEdge });
    } else if (eaEdge && ebEdge) {
      const touchesReAdded = reAdded.has(eaEdge.src) || reAdded.has(eaEdge.dst);
      if (edgeChanged(eaEdge, ebEdge) || touchesReAdded) {
        out.edgeRemoves.push({ t: 'edge:remove', graph: graphId, id: id as EdgeId, prev: eaEdge });
        out.edgeAdds.push({ t: 'edge:add', graph: graphId, edge: ebEdge });
      }
    }
  }
}

function diffAttrs(
  graphId: GraphId,
  id: NodeId,
  na: SemanticNode,
  nb: SemanticNode,
  attrSets: GraphOpInput[],
): void {
  const keys = [...new Set([...Object.keys(na.attrs), ...Object.keys(nb.attrs)])].sort(byString);
  for (const key of keys) {
    const prev: AttrValue | undefined = na.attrs[key];
    const next: AttrValue | undefined = nb.attrs[key];
    if (deepEqual(prev, next)) continue;
    attrSets.push({
      t: 'node:attr',
      graph: graphId,
      id,
      key,
      ...(prev !== undefined ? { prev } : {}),
      ...(next !== undefined ? { next } : {}),
    });
  }
}
