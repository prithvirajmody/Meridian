/**
 * The `elk-layered` provider (ROADMAP Phase 4 §3, §9; subphase 4D): a real,
 * compound-aware layered engine over **elkjs** (the bundled build, which runs
 * synchronously in-process with no Web Worker — exactly ADR-0017's "elk is a
 * single blocking call, not interruptible mid-call"). It turns a cut + induced
 * edges into world-space positions with:
 *
 * - **Compound nodes** (ROADMAP §3): nested graphs become ELK compound nodes.
 *   `LayoutInput.compound` groups members under synthetic container nodes that
 *   nest per the cut's graph-containment forest; members stay leaves at their
 *   input `Size`, and the container boxes elk computes are layout scaffolding —
 *   **not returned** in `positions` (they carry no `NodeId`, ADR-0015).
 * - **Position hints for stability** (ADR-0016): when `prev` is supplied, each
 *   persistent member is fed its prior position as an ELK interactive hint
 *   (`elk.position` + interactive strategies), so elk perturbs minimally around
 *   the previous placement. The *score* is the pure `stabilityScore`, recomputed
 *   here and verified by CI (a provider cannot self-report a lie).
 * - **Optional orthogonal edge routes** (ROADMAP §9c): `elk.edgeRouting:
 *   ORTHOGONAL` emits polyline `sections`, surfaced as `LayoutResult.edgeRoutes`
 *   keyed by the induced edge's `"src→dst→kind"` identity (ADR-0013/0015).
 *
 * **Determinism (I6).** elkjs decorates its objects with per-run identity
 * hashcodes, but the *geometry* (node x/y/w/h and edge section points) is a
 * deterministic function of the input structure. This provider (a) builds the
 * ELK tree in a canonical order — every node/group/edge ordered by ascending
 * member index, never by id string — and (b) reads back only geometry, never
 * the hashcodes. The worker runs on order-preserving placeholder ids and
 * placeholder group keys (protocol.ts); because ordering is index-driven, its
 * geometry is byte-identical to the main thread's (the worker-parity test).
 *
 * Core-law: elkjs is the one *engine* dependency (pure JS, isomorphic — no DOM,
 * no `node:*`), allowed for `layout/src` alongside comlink in the depcruiser
 * config. No domain words, no AI.
 */
import type { NodeId } from '@meridian/graph-core';
import ElkDefaultImport from 'elkjs/lib/elk.bundled.js';
import type {
  ElkExtendedEdge,
  ELK,
  ELKConstructorArguments,
  ElkNode,
  LayoutOptions,
} from 'elkjs/lib/elk-api.js';

/** elkjs ships the bundled build as CJS; under NodeNext without
 * `esModuleInterop` the default import's *type* is the module namespace (not
 * constructable), while at runtime it is the constructor (verified: the bundled
 * build runs synchronously in Node with no Web Worker). Cast to the precise
 * constructor type the `elk-api` d.ts declares. */
const ElkConstructor = ElkDefaultImport as unknown as new (args?: ELKConstructorArguments) => ELK;
import { resolveGroups } from './compound.js';
import type { Point, Rect, Size } from './coords.js';
import { boundsOf, DEFAULT_SPACING, EMPTY_BOUNDS } from './geometry.js';
import { stabilityScore } from './stability.js';
import type { LayoutInput, LayoutProvider, LayoutResult } from './types.js';

const ZERO_SIZE: Size = { width: 0, height: 0 };

/** Lazily-constructed, reused ELK instance. Compute calls are serialized (the
 * worker runs one at a time; the main thread awaits each), and elk holds no
 * per-graph state across `layout()` calls, so a singleton is safe and avoids
 * per-call construction cost. The bundled build's `terminateWorker` throws (no
 * real worker), so it is never called. */
let elkSingleton: ELK | undefined;
function elk(): ELK {
  if (elkSingleton === undefined) elkSingleton = new ElkConstructor();
  return elkSingleton;
}

/** Elk node ids are structural, derived from indices (never the real NodeId),
 * so worker (placeholder) and main (real) trees are identical. */
function memberElkId(i: number): string {
  return `n${i}`;
}
function groupElkId(g: number): string {
  return `c${g}`;
}

/** One node in the ELK tree we build: a leaf member or a synthetic container. */
interface TreeNode {
  readonly elkId: string;
  /** The member index this node stands for (leaf), or the group ordinal
   * (container). Used only for canonical ordering. */
  orderKey: number;
  readonly children: TreeNode[];
  /** Member index if this is a leaf member; `undefined` for a container. */
  readonly memberIndex?: number;
}

/** Build the canonical ELK node tree (root's `children`) from members + groups.
 * Every container's / member's children are ordered by ascending `orderKey`
 * (member index for members, min-member ordinal for groups). */
function buildTree(
  members: readonly NodeId[],
  sizes: ReadonlyMap<NodeId, Size>,
  memberGroup: number[],
  groupParent: number[],
  prev: ReadonlyMap<NodeId, Rect> | undefined,
): ElkNode[] {
  const G = groupParent.length;
  const containers: TreeNode[] = [];
  for (let g = 0; g < G; g++) {
    containers.push({ elkId: groupElkId(g), orderKey: Number.POSITIVE_INFINITY, children: [] });
  }
  const rootChildren: TreeNode[] = [];

  const attach = (node: TreeNode, parentGroup: number): void => {
    if (parentGroup >= 0) containers[parentGroup]!.children.push(node);
    else rootChildren.push(node);
  };

  // Members (leaves) into their group; a group's orderKey is the min member idx.
  for (let i = 0; i < members.length; i++) {
    const leaf: TreeNode = { elkId: memberElkId(i), orderKey: i, children: [], memberIndex: i };
    attach(leaf, memberGroup[i]!);
  }
  // Group orderKey = smallest orderKey among descendants; groups nest into
  // their parent group (or root). Since ordinals are assigned by ascending min
  // member index, a group ordinal already equals its min-member rank — use it.
  for (let g = 0; g < G; g++) {
    const node = containers[g]!;
    node.orderKey = g;
    attach(node, groupParent[g]!);
  }

  const toElk = (node: TreeNode): ElkNode => {
    node.children.sort((a, b) => a.orderKey - b.orderKey);
    if (node.memberIndex !== undefined) {
      const id = members[node.memberIndex]!;
      const s = sizes.get(id) ?? ZERO_SIZE;
      const p = prev?.get(id);
      const elkNode: ElkNode = { id: node.elkId, width: s.width, height: s.height };
      if (p !== undefined) {
        (elkNode as { layoutOptions?: LayoutOptions }).layoutOptions = {
          'elk.position': `(${p.x},${p.y})`,
        };
      }
      return elkNode;
    }
    return { id: node.elkId, children: node.children.map(toElk) };
  };

  rootChildren.sort((a, b) => a.orderKey - b.orderKey);
  return rootChildren.map(toElk);
}

/** Root layout options; interactive when `prev` supplies position hints. */
function rootOptions(input: LayoutInput, hasPrev: boolean): LayoutOptions {
  const spacing = input.hints.spacing !== undefined && input.hints.spacing >= 0 ? input.hints.spacing : DEFAULT_SPACING;
  const direction = input.hints.direction === 'right' ? 'RIGHT' : 'DOWN';
  const opts: LayoutOptions = {
    'elk.algorithm': 'layered',
    'elk.direction': direction,
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    'elk.spacing.nodeNode': String(spacing),
    'elk.layered.spacing.nodeNodeBetweenLayers': String(spacing),
    'elk.spacing.edgeNode': String(spacing / 2),
  };
  if (hasPrev) {
    // Interactive position hints (ADR-0016 mechanism): elk derives layer
    // assignment and within-layer order from each persistent node's prior
    // `elk.position`, so the structure barely perturbs. `semiInteractive`
    // crossing minimization keeps prior columns while still ordering *new*
    // nodes by layer-sweep — measured far more stable than fully INTERACTIVE
    // crossing minimization (which re-derives, and can flip whole branches).
    opts['elk.interactive'] = 'true';
    opts['elk.layered.layering.strategy'] = 'INTERACTIVE';
    opts['elk.layered.crossingMinimization.semiInteractive'] = 'true';
    opts['elk.layered.cycleBreaking.strategy'] = 'INTERACTIVE';
  }
  return opts;
}

/** Absolute origin of every container, so edge sections (which elk emits
 * relative to their `container`) and nested children can be lifted to world
 * space. Keyed by elk node id; `root` is `(0,0)`. */
function absoluteOrigins(root: ElkNode): Map<string, Point> {
  const origins = new Map<string, Point>([['root', { x: 0, y: 0 }]]);
  const walk = (node: ElkNode, ox: number, oy: number): void => {
    for (const c of node.children ?? []) {
      const ax = ox + (c.x ?? 0);
      const ay = oy + (c.y ?? 0);
      origins.set(c.id, { x: ax, y: ay });
      walk(c, ax, ay);
    }
  };
  walk(root, 0, 0);
  return origins;
}

/** The `"src→dst→kind"` identity of an induced edge (ADR-0013/0015). */
function edgeKey(src: NodeId, dst: NodeId, kind: string): string {
  return `${src}→${dst}→${kind}`;
}

export const elkLayeredProvider: LayoutProvider = {
  id: 'elk-layered',
  capabilities: { incremental: true, compound: true, deterministic: true },
  async compute(input: LayoutInput, prev?: LayoutResult, _signal?: AbortSignal): Promise<LayoutResult> {
    const members = input.cut.members;
    const N = members.length;
    if (N === 0) {
      return { positions: new Map<NodeId, Rect>(), bounds: EMPTY_BOUNDS, stability: 1 };
    }

    const prevPositions = prev?.positions;
    const { memberGroup, groupParent } = resolveGroups(members, input.compound);
    const children = buildTree(members, input.sizes, memberGroup, groupParent, prevPositions);

    // Edges: declared at root (INCLUDE_CHILDREN lets them cross group
    // boundaries), in canonical (input) order with structural ids.
    const elkEdges: ElkExtendedEdge[] = [];
    const memberIndex = new Map<NodeId, number>();
    members.forEach((m, i) => memberIndex.set(m, i));
    for (let j = 0; j < input.edges.length; j++) {
      const e = input.edges[j]!;
      const s = memberIndex.get(e.src);
      const d = memberIndex.get(e.dst);
      if (s === undefined || d === undefined || s === d) continue; // drop non-members / self
      elkEdges.push({ id: `e${j}`, sources: [memberElkId(s)], targets: [memberElkId(d)] });
    }

    const graph: ElkNode = {
      id: 'root',
      layoutOptions: rootOptions(input, prevPositions !== undefined && prevPositions.size > 0),
      children,
      edges: elkEdges,
    };

    const laid = await elk().layout(graph);

    // Read back geometry only (never elk's per-run hashcodes) → determinism.
    const origins = absoluteOrigins(laid);
    let positions = new Map<NodeId, Rect>();
    for (let i = 0; i < N; i++) {
      const id = members[i]!;
      const s = input.sizes.get(id) ?? ZERO_SIZE;
      const org = origins.get(memberElkId(i));
      const x = org?.x ?? 0;
      const y = org?.y ?? 0;
      positions.set(id, { x, y, width: s.width, height: s.height });
    }

    // Edge routes (orthogonal polylines), lifted to world space by container.
    let routes = new Map<string, readonly Point[]>();
    collectRoutes(laid, origins, (elkEdgeId, poly) => {
      const j = Number(elkEdgeId.slice(1));
      const e = input.edges[j];
      if (e === undefined || poly.length < 2) return;
      routes.set(edgeKey(e.src, e.dst, e.kind), poly);
    });

    // Stability anchoring (ADR-0016 mechanism, alongside the interactive
    // position hints): the interactive layout preserves *relative* structure,
    // but elk re-derives absolute coordinates from the origin, so a delta can
    // translate the whole diagram — which the absolute-displacement score
    // penalizes. Translate the result by the mean prev→current offset of the
    // persistent members (centroid alignment minimizes summed displacement), so
    // nodes that kept their structural place also keep their world place. Pure
    // and deterministic; the score is still recomputed independently by CI.
    const offset = anchorOffset(positions, prevPositions);
    if (offset !== undefined) {
      positions = translatePositions(positions, offset);
      routes = translateRoutes(routes, offset);
    }

    const routePoints: Point[] = [];
    for (const poly of routes.values()) for (const p of poly) routePoints.push(p);

    const bounds = boundsOf(positions.values(), routePoints);
    const draft: LayoutResult =
      routes.size > 0 ? { positions, edgeRoutes: routes, bounds, stability: 1 } : { positions, bounds, stability: 1 };
    const { stability } = stabilityScore(prev, draft, input.hints);
    return { ...draft, stability };
  },
};

/** The mean prev→current displacement over persistent members (centroid
 * alignment). `undefined` when there is no prior layout to anchor to. */
function anchorOffset(
  positions: ReadonlyMap<NodeId, Rect>,
  prev: ReadonlyMap<NodeId, Rect> | undefined,
): Point | undefined {
  if (prev === undefined || prev.size === 0) return undefined;
  let sx = 0;
  let sy = 0;
  let count = 0;
  for (const [id, cur] of positions) {
    const p = prev.get(id);
    if (p === undefined) continue;
    sx += p.x - cur.x;
    sy += p.y - cur.y;
    count++;
  }
  if (count === 0) return undefined;
  return { x: sx / count, y: sy / count };
}

function translatePositions(positions: ReadonlyMap<NodeId, Rect>, off: Point): Map<NodeId, Rect> {
  const out = new Map<NodeId, Rect>();
  for (const [id, r] of positions) out.set(id, { x: r.x + off.x, y: r.y + off.y, width: r.width, height: r.height });
  return out;
}

function translateRoutes(
  routes: ReadonlyMap<string, readonly Point[]>,
  off: Point,
): Map<string, readonly Point[]> {
  const out = new Map<string, readonly Point[]>();
  for (const [k, poly] of routes) out.set(k, poly.map((p) => ({ x: p.x + off.x, y: p.y + off.y })));
  return out;
}

/** Walk the laid-out tree, emitting each edge's absolute polyline. Edge section
 * coordinates are relative to the edge's `container` (defaulting to the node it
 * is declared on); we add that container's absolute origin. */
function collectRoutes(
  root: ElkNode,
  origins: Map<string, Point>,
  emit: (elkEdgeId: string, poly: Point[]) => void,
): void {
  const visit = (node: ElkNode): void => {
    const edges = (node as { edges?: ElkExtendedEdge[] }).edges;
    if (edges !== undefined) {
      for (const e of edges) {
        const containerId = (e as { container?: string }).container ?? node.id;
        const org = origins.get(containerId) ?? { x: 0, y: 0 };
        const poly: Point[] = [];
        for (const sec of e.sections ?? []) {
          poly.push({ x: org.x + sec.startPoint.x, y: org.y + sec.startPoint.y });
          for (const b of sec.bendPoints ?? []) poly.push({ x: org.x + b.x, y: org.y + b.y });
          poly.push({ x: org.x + sec.endPoint.x, y: org.y + sec.endPoint.y });
        }
        emit(e.id, poly);
      }
    }
    for (const c of node.children ?? []) visit(c);
  };
  visit(root);
}
