/**
 * Host-side detail assembly (7F, ADR-0027): turn a worker-built {@link RawBody}
 * into an op-based delta that materializes a cold function's CFG + AST. This is
 * the resolver's analogue of {@link ../document.js buildCodeDocument}: it derives
 * every id from `ctx.ids` (ADR-0002/0028) and emits **through the ordinary
 * op vocabulary** (ADR-0005 — no second write path). Because body ids come from
 * the function's own coordinates, the structure is byte-identical whether it
 * were materialized eagerly or lazily (the ADR-0027 invariant).
 *
 * The delta's ops (plain wire objects — the op vocabulary lives in graph-store
 * and is decoded downstream, exactly like an ingest delta):
 * - `graph:add` for the CFG graph (the function's detail) and each block's AST
 *   graph and each nested expression graph;
 * - `node:add` for every `code:block` / `code:stmt` / `code:expr`;
 * - `edge:add` for every `code:flows-to`;
 * - `node:detail` flipping the function's `detail` from absent → the CFG graph.
 *
 * `src` imports no `node:*`, no graph-core (a devDep only) — ids come through
 * the injected `IdFacade`, the same discipline as the eager document builder.
 */
import type { DeltaWire, DetailGraphRef, DetailNode, IdFacade } from '@meridian/plugin-api';
import { DOMAIN } from '../document.js';
import type { RawAst, RawBody } from './types.js';

/** The origin actor stamped on a resolver-emitted delta. */
export const DETAIL_ACTOR = 'code:detail-resolver';

type Op = Record<string, unknown>;
type Coords = { readonly domain: string; readonly source: string; readonly path: readonly string[] };

/** Thrown when a node lacks the eager attrs a resolve needs (a bug / stale node). */
export class DetailResolveError extends Error {}

function scopePathOf(node: DetailNode): readonly string[] {
  const v = node.attrs?.['code:scope-path'];
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) {
    throw new DetailResolveError(
      `code detail-resolver: node "${node.id}" has no code:scope-path attr — not an eager function/method node`,
    );
  }
  return v as readonly string[];
}

/**
 * Build the materialization delta for `node`'s body. Returns the delta and the
 * new detail ref (the CFG graph). Deterministic and idempotent: same node +
 * same body ⇒ byte-identical ops with identical ids.
 */
export function buildBodyDelta(
  ids: IdFacade,
  node: DetailNode,
  body: RawBody,
): { readonly delta: DeltaWire; readonly detail: DetailGraphRef } {
  const source = node.provenance.uri;
  if (source === undefined) {
    throw new DetailResolveError(`code detail-resolver: node "${node.id}" has no provenance uri`);
  }
  const scopePath = scopePathOf(node);
  const coordsAt = (path: readonly string[]): Coords => ({ domain: DOMAIN, source, path });
  const prov = (span?: readonly [number, number]): Op => ({
    origin: 'source',
    uri: source,
    ...(span !== undefined ? { span: [span[0], span[1]] } : {}),
  });

  const fnCoords = coordsAt(scopePath);
  const cfgGraphId = ids.graphId(fnCoords);
  const parentGraphId = ids.graphId(coordsAt(scopePath.slice(0, -1)));
  const blockCoords = (key: string): Coords => coordsAt([...scopePath, `block-${key}`]);
  const blockNodeId = (key: string): string => ids.nodeId(blockCoords(key));

  const ops: Op[] = [];

  // The CFG graph is the function's (previously cold) detail graph.
  ops.push({
    t: 'graph:add',
    graph: cfgGraphId,
    meta: { label: `${node.label} · control-flow`, domain: DOMAIN, provenance: prov(node.provenance.span) },
  });

  // Blocks (and, for non-empty blocks, their AST subgraphs). A detail graph is
  // added **before** the node that references it — the store validates a
  // node:add's detail target exists (`unknown-detail-graph`).
  for (const block of body.blocks) {
    const coord = blockCoords(block.key);
    const nodeId = blockNodeId(block.key);
    const hasStmts = block.stmts.length > 0;
    const astGraphId = hasStmts ? ids.graphId(coord) : undefined;
    if (astGraphId !== undefined) {
      ops.push({
        t: 'graph:add',
        graph: astGraphId,
        meta: { label: `${block.label} · ast`, domain: DOMAIN, provenance: prov(block.span) },
      });
    }
    ops.push({
      t: 'node:add',
      graph: cfgGraphId,
      node: {
        id: nodeId,
        kind: `${DOMAIN}:block`,
        label: block.label,
        ...(astGraphId !== undefined ? { detail: { graph: astGraphId } } : {}),
        attrs: { 'code:block-role': block.role },
        provenance: prov(block.span),
      },
    });
    if (astGraphId !== undefined) addAst(ids, ops, prov, coord, astGraphId, block.stmts);
  }

  // Flow edges (occurrence = the flow label, so parallel labelled edges are
  // distinct ids — e.g. a head with both `true` and `false` to two blocks).
  for (const flow of body.flows) {
    const src = blockNodeId(flow.from);
    const dst = blockNodeId(flow.to);
    ops.push({
      t: 'edge:add',
      graph: cfgGraphId,
      edge: {
        id: ids.edgeId({ graph: cfgGraphId, kind: `${DOMAIN}:flows-to`, src, dst, occurrence: flow.label }),
        src,
        dst,
        kind: `${DOMAIN}:flows-to`,
        attrs: { 'code:flow': flow.label },
        provenance: prov(),
      },
    });
  }

  // Flip the function's detail cold → hot (the drill-in), last.
  ops.push({ t: 'node:detail', graph: parentGraphId, id: node.id, next: { graph: cfgGraphId } });

  return { delta: { ops, origin: { actor: DETAIL_ACTOR } }, detail: { graph: cfgGraphId } };
}

/** Recursively emit `code:stmt`/`code:expr` nodes (and their nested graphs). */
function addAst(
  ids: IdFacade,
  ops: Op[],
  prov: (span?: readonly [number, number]) => Op,
  parentCoords: Coords,
  parentGraphId: string,
  asts: readonly RawAst[],
): void {
  for (const ast of asts) {
    const coord: Coords = { ...parentCoords, path: [...parentCoords.path, ast.key] };
    const nodeId = ids.nodeId(coord);
    const hasChildren = ast.children.length > 0;
    const detailId = hasChildren ? ids.graphId(coord) : undefined;
    if (detailId !== undefined) {
      ops.push({
        t: 'graph:add',
        graph: detailId,
        meta: { label: ast.label, domain: DOMAIN, provenance: prov(ast.span) },
      });
    }
    ops.push({
      t: 'node:add',
      graph: parentGraphId,
      node: {
        id: nodeId,
        kind: `${DOMAIN}:${ast.kind}`,
        label: ast.label,
        ...(detailId !== undefined ? { detail: { graph: detailId } } : {}),
        attrs: { 'code:ast-kind': ast.type },
        provenance: prov(ast.span),
      },
    });
    if (detailId !== undefined) addAst(ids, ops, prov, coord, detailId, ast.children);
  }
}
