/**
 * Element ↔ row codecs. Rows store the ADR-0004 wire shapes, canonically
 * rendered (sorted attr keys, fixed provenance key order), so a checkpoint
 * is byte-stable and round-trips are exact. Rows are written only by this
 * package from already-canonical in-store values, so reading trusts shape
 * (the space is still validated once at open by `createStore`).
 */
import type {
  AttrBag,
  AttrValue,
  EdgeId,
  GraphId,
  GraphMeta,
  NodeId,
  SemanticEdge,
  SemanticNode,
  SourceRef,
} from '@meridian/graph-core';
import type { SqlRow, SqlValue } from './driver.js';

export function attrsToJson(attrs: AttrBag): string | null {
  const keys = Object.keys(attrs);
  if (keys.length === 0) return null;
  const out: Record<string, AttrValue> = {};
  for (const key of keys.sort()) out[key] = attrs[key]!;
  return JSON.stringify(out);
}

export function jsonToAttrs(json: SqlValue | undefined): AttrBag {
  if (json === null || json === undefined) return {};
  return JSON.parse(String(json)) as AttrBag;
}

export function provenanceToJson(p: SourceRef): string {
  return JSON.stringify({
    origin: p.origin,
    ...(p.uri !== undefined ? { uri: p.uri } : {}),
    ...(p.span !== undefined ? { span: [p.span[0], p.span[1]] } : {}),
    ...(p.providerId !== undefined ? { providerId: p.providerId } : {}),
    ...(p.model !== undefined ? { model: p.model } : {}),
    ...(p.promptVersion !== undefined ? { promptVersion: p.promptVersion } : {}),
    ...(p.inputHash !== undefined ? { inputHash: p.inputHash } : {}),
    ...(p.confidence !== undefined ? { confidence: p.confidence } : {}),
  });
}

export function jsonToProvenance(json: SqlValue | undefined): SourceRef {
  return JSON.parse(String(json)) as SourceRef;
}

// ------------------------------------------------------------------- graphs

export function graphRowParams(id: GraphId, meta: GraphMeta): SqlValue[] {
  return [id, meta.label, meta.domain, provenanceToJson(meta.provenance)];
}

export function rowToMeta(row: SqlRow): GraphMeta {
  return {
    label: String(row.label),
    domain: String(row.domain),
    provenance: jsonToProvenance(row.provenance),
  };
}

// -------------------------------------------------------------------- nodes

export function nodeRowParams(graphId: GraphId, node: SemanticNode): SqlValue[] {
  return [
    node.id,
    graphId,
    node.kind,
    node.label,
    node.detail ? node.detail.graph : null,
    attrsToJson(node.attrs),
    provenanceToJson(node.provenance),
  ];
}

export function rowToNode(row: SqlRow): SemanticNode {
  return {
    id: String(row.id) as NodeId,
    kind: String(row.kind),
    label: String(row.label),
    ...(row.detail_graph !== null && row.detail_graph !== undefined
      ? { detail: { graph: String(row.detail_graph) as GraphId } }
      : {}),
    attrs: jsonToAttrs(row.attrs),
    provenance: jsonToProvenance(row.provenance),
  };
}

// -------------------------------------------------------------------- edges

export function edgeRowParams(graphId: GraphId, edge: SemanticEdge): SqlValue[] {
  return [
    edge.id,
    graphId,
    edge.src,
    edge.dst,
    edge.kind,
    edge.weight ?? null,
    attrsToJson(edge.attrs),
    provenanceToJson(edge.provenance),
  ];
}

export function rowToEdge(row: SqlRow): SemanticEdge {
  return {
    id: String(row.id) as EdgeId,
    src: String(row.src) as NodeId,
    dst: String(row.dst) as NodeId,
    kind: String(row.kind),
    ...(row.weight !== null && row.weight !== undefined ? { weight: Number(row.weight) } : {}),
    attrs: jsonToAttrs(row.attrs),
    provenance: jsonToProvenance(row.provenance),
  };
}
