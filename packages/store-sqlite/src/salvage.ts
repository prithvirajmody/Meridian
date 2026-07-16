/**
 * Best-effort export of a damaged project (ADR-0038 §6): read whatever
 * element rows still parse, drop what dangles, and produce an ADR-0004
 * document plus a located issue list. Never writes to the damaged file.
 */
import {
  encode,
  validate,
  type EncodeOptions,
  type GraphDocument,
  type GraphId,
  type GraphSpace,
  type SemanticEdge,
  type SemanticGraph,
  type SemanticNode,
} from '@meridian/graph-core';
import type { SqlDriver, SqlRow } from './driver.js';
import { rowToEdge, rowToMeta, rowToNode } from './rows.js';

export interface SalvageResult {
  readonly document: GraphDocument | null;
  readonly issues: readonly string[];
}

function tryRows(db: SqlDriver, sql: string, issues: string[], what: string): SqlRow[] {
  try {
    return db.all(sql);
  } catch (e) {
    issues.push(`${what}: unreadable (${e instanceof Error ? e.message : String(e)})`);
    return [];
  }
}

export function salvageToDocument(db: SqlDriver, opts: EncodeOptions = {}): SalvageResult {
  const issues: string[] = [];
  const graphs = new Map<GraphId, { meta: SemanticGraph['meta']; nodes: Map<SemanticNode['id'], SemanticNode>; edges: Map<SemanticEdge['id'], SemanticEdge> }>();

  for (const row of tryRows(db, 'SELECT id, label, domain, provenance FROM graphs ORDER BY id', issues, 'graphs')) {
    try {
      graphs.set(String(row.id) as GraphId, { meta: rowToMeta(row), nodes: new Map(), edges: new Map() });
    } catch (e) {
      issues.push(`graph ${String(row.id)}: dropped (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  for (const row of tryRows(
    db,
    'SELECT id, graph_id, kind, label, detail_graph, attrs, provenance FROM nodes ORDER BY id',
    issues,
    'nodes',
  )) {
    const owner = graphs.get(String(row.graph_id) as GraphId);
    if (!owner) {
      issues.push(`node ${String(row.id)}: dropped — owning graph ${String(row.graph_id)} is missing`);
      continue;
    }
    try {
      const node = rowToNode(row);
      owner.nodes.set(node.id, node);
    } catch (e) {
      issues.push(`node ${String(row.id)}: dropped (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  for (const row of tryRows(
    db,
    'SELECT id, graph_id, src, dst, kind, weight, attrs, provenance FROM edges ORDER BY id',
    issues,
    'edges',
  )) {
    const owner = graphs.get(String(row.graph_id) as GraphId);
    if (!owner) {
      issues.push(`edge ${String(row.id)}: dropped — owning graph ${String(row.graph_id)} is missing`);
      continue;
    }
    try {
      const edge = rowToEdge(row);
      if (!owner.nodes.has(edge.src) || !owner.nodes.has(edge.dst)) {
        issues.push(`edge ${String(row.id)}: dropped — endpoint missing`);
        continue;
      }
      owner.edges.set(edge.id, edge);
    } catch (e) {
      issues.push(`edge ${String(row.id)}: dropped (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  // Containment: strip detail refs to missing graphs; enforce single
  // ownership (first claimant wins) so U3 holds in the salvage output.
  const stripDetail = (node: SemanticNode): SemanticNode => {
    const copy: SemanticNode & { detail?: unknown } = { ...node };
    delete copy.detail;
    return copy;
  };
  const claimed = new Set<string>();
  for (const [graphId, g] of graphs) {
    for (const [nodeId, node] of g.nodes) {
      if (!node.detail) continue;
      if (!graphs.has(node.detail.graph)) {
        issues.push(`node ${nodeId}: detail ref to missing graph ${node.detail.graph} stripped`);
        g.nodes.set(nodeId, stripDetail(node));
      } else if (claimed.has(node.detail.graph)) {
        issues.push(`node ${nodeId} in ${graphId}: duplicate claim of graph ${node.detail.graph} stripped (single ownership)`);
        g.nodes.set(nodeId, stripDetail(node));
      } else {
        claimed.add(node.detail.graph);
      }
    }
  }

  const roots = [...graphs.keys()].filter((id) => !claimed.has(id)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const space: GraphSpace = {
    graphs: new Map([...graphs].map(([id, g]) => [id, { id, meta: g.meta, nodes: g.nodes, edges: g.edges }])),
    roots,
  };

  const check = validate(space);
  if (!check.ok) {
    for (const err of check.errors) issues.push(`salvaged space still invalid: [${err.code}] ${err.message}`);
    return { document: null, issues };
  }
  try {
    return { document: encode(space, opts), issues };
  } catch (e) {
    issues.push(`encode failed: ${e instanceof Error ? e.message : String(e)}`);
    return { document: null, issues };
  }
}
