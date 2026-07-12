/**
 * Build a resolved body's **graphs** (not ops): the wire form the incremental
 * session diffs across an edit (7G, ADR-0027 composition). It is the graph-shaped
 * twin of {@link ../detail/build-detail.js buildBodyDelta} — same ids, same
 * structure, same byte-identity invariant (body ids derive from the function's
 * ADR-0028 coordinates) — so a hot body re-materialized after an edit diffs
 * cleanly against its prior materialization: an unchanged body ⇒ identical
 * graphs ⇒ empty delta; a changed body ⇒ a minimal delta over the body subtree.
 *
 * Graphs are returned as a **flat** list (a GraphDocument is flat, ADR-0001):
 * every AST/nested graph precedes the CFG graph, and the CFG is last, so a
 * consumer adding graphs in order always has a node's detail target already
 * present.
 */
import type { IdFacade } from '@meridian/plugin-api';
import { DetailResolveError } from '../detail/build-detail.js';
import type { RawAst, RawBody } from '../detail/types.js';
import { DOMAIN } from '../document.js';
import type { Provenance, WireEdge, WireGraph, WireNode } from './wire.js';

type Coords = { readonly domain: string; readonly source: string; readonly path: readonly string[] };

interface DetailNodeLike {
  readonly id: string;
  readonly label: string;
  readonly provenance: Provenance;
  readonly attrs?: Record<string, unknown>;
}

function scopePathOf(node: DetailNodeLike): readonly string[] {
  const v = node.attrs?.['code:scope-path'];
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) {
    throw new DetailResolveError(
      `code incremental: node "${node.id}" has no code:scope-path attr — not an eager function/method node`,
    );
  }
  return v as readonly string[];
}

export interface BodyGraphs {
  /** All graphs the body materializes: each block's AST graph and nested
   * expression graphs first, then the CFG graph (the function's detail) last. */
  readonly graphs: readonly WireGraph[];
  /** The function's new detail ref (the CFG graph). */
  readonly detail: { readonly graph: string };
}

export function buildBodyGraphs(ids: IdFacade, node: DetailNodeLike, body: RawBody): BodyGraphs {
  const source = node.provenance.uri;
  if (source === undefined) {
    throw new DetailResolveError(`code incremental: node "${node.id}" has no provenance uri`);
  }
  const scopePath = scopePathOf(node);
  const coordsAt = (path: readonly string[]): Coords => ({ domain: DOMAIN, source, path });
  const prov = (span?: readonly [number, number]): Provenance =>
    ({ origin: 'source', uri: source, ...(span !== undefined ? { span: [span[0], span[1]] as [number, number] } : {}) }) as Provenance;

  const cfgGraphId = ids.graphId(coordsAt(scopePath));
  const blockCoords = (key: string): Coords => coordsAt([...scopePath, `block-${key}`]);
  const blockNodeId = (key: string): string => ids.nodeId(blockCoords(key));

  const graphs: WireGraph[] = [];
  const cfgNodes: WireNode[] = [];
  const cfgEdges: WireEdge[] = [];

  for (const block of body.blocks) {
    const coord = blockCoords(block.key);
    const nodeId = blockNodeId(block.key);
    const astGraphId = block.stmts.length > 0 ? ids.graphId(coord) : undefined;
    if (astGraphId !== undefined) {
      addAstGraphs(ids, graphs, prov, coord, astGraphId, `${block.label} · ast`, block.span, block.stmts);
    }
    cfgNodes.push({
      id: nodeId,
      kind: `${DOMAIN}:block`,
      label: block.label,
      ...(astGraphId !== undefined ? { detail: { graph: astGraphId } } : {}),
      attrs: { 'code:block-role': block.role },
      provenance: prov(block.span),
    } as WireNode);
  }

  for (const flow of body.flows) {
    const src = blockNodeId(flow.from);
    const dst = blockNodeId(flow.to);
    cfgEdges.push({
      id: ids.edgeId({ graph: cfgGraphId, kind: `${DOMAIN}:flows-to`, src, dst, occurrence: flow.label }),
      src,
      dst,
      kind: `${DOMAIN}:flows-to`,
      attrs: { 'code:flow': flow.label },
      provenance: prov(),
    } as WireEdge);
  }

  graphs.push({
    id: cfgGraphId,
    meta: { label: `${node.label} · control-flow`, domain: DOMAIN, provenance: prov(node.provenance.span) },
    nodes: cfgNodes,
    edges: cfgEdges,
  } as WireGraph);

  return { graphs, detail: { graph: cfgGraphId } };
}

/** Emit an AST graph (and any nested-expression graphs before it) into `out`. */
function addAstGraphs(
  ids: IdFacade,
  out: WireGraph[],
  prov: (span?: readonly [number, number]) => Provenance,
  parentCoords: Coords,
  graphId: string,
  label: string,
  ownerSpan: readonly [number, number],
  asts: readonly RawAst[],
): void {
  const nodes: WireNode[] = [];
  for (const ast of asts) {
    const coord: Coords = { ...parentCoords, path: [...parentCoords.path, ast.key] };
    const nodeId = ids.nodeId(coord);
    const detailId = ast.children.length > 0 ? ids.graphId(coord) : undefined;
    if (detailId !== undefined) {
      addAstGraphs(ids, out, prov, coord, detailId, ast.label, ast.span, ast.children);
    }
    nodes.push({
      id: nodeId,
      kind: `${DOMAIN}:${ast.kind}`,
      label: ast.label,
      ...(detailId !== undefined ? { detail: { graph: detailId } } : {}),
      attrs: { 'code:ast-kind': ast.type },
      provenance: prov(ast.span),
    } as WireNode);
  }
  out.push({ id: graphId, meta: { label, domain: DOMAIN, provenance: prov(ownerSpan) }, nodes, edges: [] } as WireGraph);
}
