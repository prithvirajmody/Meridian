/**
 * The incremental differ (7G): two wire documents in, a **minimal**, store-valid
 * op list out. It is the adapter-local analogue of graph-store's `diffSpaces`
 * (which the adapter may not import, §20), specialized two ways:
 *
 * 1. **Span exclusion** (ADR-0028): node/edge/graph equality ignores byte
 *    offsets (provenance span, `code:body-span`, `code:call-sites`), so a
 *    whitespace-only edit — which shifts every span but changes no id, kind,
 *    label, non-span attr, or detail — produces an **empty** op list. (Stored
 *    spans then lag until the next substantive touch — the ADR's flagged trade.)
 * 2. **`prev` omitted.** ADR-0005 makes an op's `prev` an *optional* assertion;
 *    the store completes it from actual state (and thus the applied delta is
 *    fully invertible). Omitting it keeps this producer free of graph-store's
 *    canonicalization, and never risks an `op-conflict` against a
 *    store-canonicalized node.
 *
 * Op ordering is `diffSpaces`'s, and for the same reason — every prefix is
 * applicable, no transient double-claim or dangling reference:
 *   remove: edge:remove → detail clear → node:remove → graph:remove
 *   add:    graph:add → graph:meta → node:add → detail set → node:attr → edge:add
 */
import type { GraphDocument } from '@meridian/plugin-api';
import {
  attrsEqualModuloSpan,
  byString,
  deepEqual,
  metaEqualModuloSpan,
  provEqualModuloSpan,
  SPAN_EDGE_ATTRS,
  SPAN_NODE_ATTRS,
  type Op,
  type WireEdge,
  type WireGraph,
  type WireNode,
} from './wire.js';

function index<T extends { readonly id: string }>(items: readonly T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const it of items) m.set(it.id, it);
  return m;
}

function sortedUnion(a: Iterable<string>, b: Iterable<string>): string[] {
  return [...new Set([...a, ...b])].sort(byString);
}

/** Core identity: differing kind/label/provenance-excluding-span forces
 * remove + re-add (detail and attrs are diffed in place, not here). */
function coreChanged(a: WireNode, b: WireNode): boolean {
  return a.kind !== b.kind || a.label !== b.label || !provEqualModuloSpan(a.provenance, b.provenance);
}

function edgeChanged(a: WireEdge, b: WireEdge): boolean {
  return (
    a.src !== b.src ||
    a.dst !== b.dst ||
    a.kind !== b.kind ||
    a.weight !== b.weight ||
    !attrsEqualModuloSpan(a.attrs, b.attrs, SPAN_EDGE_ATTRS) ||
    !provEqualModuloSpan(a.provenance, b.provenance)
  );
}

interface Buckets {
  edgeRemoves: Op[];
  detailClears: Op[];
  nodeRemoves: Op[];
  graphRemoves: Op[];
  graphAdds: Op[];
  graphMetas: Op[];
  nodeAdds: Op[];
  detailSets: Op[];
  attrSets: Op[];
  edgeAdds: Op[];
}

function diffAttrs(graph: string, id: string, a: WireNode, b: WireNode, out: Op[]): void {
  const aAttrs = a.attrs ?? {};
  const bAttrs = b.attrs ?? {};
  const keys = sortedUnion(Object.keys(aAttrs), Object.keys(bAttrs));
  for (const key of keys) {
    const inA = Object.prototype.hasOwnProperty.call(aAttrs, key);
    const inB = Object.prototype.hasOwnProperty.call(bAttrs, key);
    const prev = aAttrs[key];
    const next = bAttrs[key];
    if (SPAN_NODE_ATTRS.has(key)) {
      // A span attr's value drift is invisible (ADR-0028); only presence counts.
      if (inA === inB) continue;
      out.push({ t: 'node:attr', graph, id, key, ...(inB ? { next } : {}) });
      continue;
    }
    if (deepEqual(prev, next)) continue;
    out.push({ t: 'node:attr', graph, id, key, ...(inB ? { next } : {}) });
  }
}

function diffSharedGraph(graphId: string, ga: WireGraph, gb: WireGraph, out: Buckets): void {
  if (!metaEqualModuloSpan(ga.meta, gb.meta)) {
    out.graphMetas.push({ t: 'graph:meta', graph: graphId, next: gb.meta });
  }

  const na = index(ga.nodes);
  const nb = index(gb.nodes);
  const reAdded = new Set<string>();
  for (const id of sortedUnion(na.keys(), nb.keys())) {
    const a = na.get(id);
    const b = nb.get(id);
    if (a && !b) {
      out.nodeRemoves.push({ t: 'node:remove', graph: graphId, id });
    } else if (!a && b) {
      out.nodeAdds.push({ t: 'node:add', graph: graphId, node: b });
    } else if (a && b) {
      if (coreChanged(a, b)) {
        reAdded.add(id);
        out.nodeRemoves.push({ t: 'node:remove', graph: graphId, id });
        out.nodeAdds.push({ t: 'node:add', graph: graphId, node: b });
      } else {
        if (a.detail?.graph !== b.detail?.graph) {
          if (a.detail) out.detailClears.push({ t: 'node:detail', graph: graphId, id });
          if (b.detail) {
            out.detailSets.push({ t: 'node:detail', graph: graphId, id, next: { graph: b.detail.graph } });
          }
        }
        diffAttrs(graphId, id, a, b, out.attrSets);
      }
    }
  }

  const ea = index(ga.edges);
  const eb = index(gb.edges);
  for (const id of sortedUnion(ea.keys(), eb.keys())) {
    const a = ea.get(id);
    const b = eb.get(id);
    if (a && !b) {
      out.edgeRemoves.push({ t: 'edge:remove', graph: graphId, id });
    } else if (!a && b) {
      out.edgeAdds.push({ t: 'edge:add', graph: graphId, edge: b });
    } else if (a && b) {
      const touchesReAdded = reAdded.has(a.src) || reAdded.has(a.dst);
      if (edgeChanged(a, b) || touchesReAdded) {
        out.edgeRemoves.push({ t: 'edge:remove', graph: graphId, id });
        out.edgeAdds.push({ t: 'edge:add', graph: graphId, edge: b });
      }
    }
  }
}

function diffRemovedGraph(g: WireGraph, out: Buckets): void {
  for (const e of [...g.edges].sort((x, y) => byString(x.id, y.id))) {
    out.edgeRemoves.push({ t: 'edge:remove', graph: g.id, id: e.id });
  }
  for (const n of [...g.nodes].sort((x, y) => byString(x.id, y.id))) {
    if (n.detail) out.detailClears.push({ t: 'node:detail', graph: g.id, id: n.id });
    out.nodeRemoves.push({ t: 'node:remove', graph: g.id, id: n.id });
  }
  out.graphRemoves.push({ t: 'graph:remove', graph: g.id });
}

function diffAddedGraph(g: WireGraph, out: Buckets): void {
  out.graphAdds.push({ t: 'graph:add', graph: g.id, meta: g.meta });
  for (const n of [...g.nodes].sort((x, y) => byString(x.id, y.id))) out.nodeAdds.push({ t: 'node:add', graph: g.id, node: n });
  for (const e of [...g.edges].sort((x, y) => byString(x.id, y.id))) out.edgeAdds.push({ t: 'edge:add', graph: g.id, edge: e });
}

/**
 * Minimal, span-excluding op list transforming `oldDoc` → `newDoc`. Deterministic
 * (every stage sorted, I6). Ready to wrap in a `DeltaWire` and emit.
 */
export function diffCodeDocuments(oldDoc: GraphDocument, newDoc: GraphDocument): Op[] {
  const out: Buckets = {
    edgeRemoves: [],
    detailClears: [],
    nodeRemoves: [],
    graphRemoves: [],
    graphAdds: [],
    graphMetas: [],
    nodeAdds: [],
    detailSets: [],
    attrSets: [],
    edgeAdds: [],
  };
  const a = index(oldDoc.graphs);
  const b = index(newDoc.graphs);
  for (const id of sortedUnion(a.keys(), b.keys())) {
    const ga = a.get(id);
    const gb = b.get(id);
    if (ga && !gb) diffRemovedGraph(ga, out);
    else if (!ga && gb) diffAddedGraph(gb, out);
    else if (ga && gb) diffSharedGraph(id, ga, gb, out);
  }
  return [
    ...out.edgeRemoves,
    ...out.detailClears,
    ...out.nodeRemoves,
    ...out.graphRemoves,
    ...out.graphAdds,
    ...out.graphMetas,
    ...out.nodeAdds,
    ...out.detailSets,
    ...out.attrSets,
    ...out.edgeAdds,
  ];
}
