/**
 * Worker wire protocol (ADR-0017): how a `LayoutInput`/`LayoutResult` becomes
 * **transferable typed arrays** and back. Pure, isomorphic (no DOM, no
 * `node:*`, no Comlink) — just encode/decode over `ArrayBuffer`-backed views,
 * so it is unit-testable on the main thread and the exact bytes that cross the
 * boundary are the exact bytes a test can inspect.
 *
 * **Node index space.** Strings never cross for geometry. Each request assigns
 * node `i ∈ [0, N)` = its position in `cut.members`, which `buildCut` already
 * emits sorted ascending — so the index is O(N) with no sort. The main thread
 * keeps the `index ↔ NodeId` table (below); the worker computes on integer
 * indices only, re-hydrating them into **placeholder ids** whose lexicographic
 * order is identical to the members' ascending order (fixed-width zero-padded
 * decimal). Because the deterministic providers use `NodeId` only for ordering
 * and as map keys — never for coordinate *values* — running them on the
 * order-preserving placeholders yields byte-identical geometry to running them
 * on the real ids (the property the 4C golden-parity test proves).
 *
 * The encodings mirror ADR-0017's request/response tables exactly. Edge
 * `multiplicity`/`samples` are intentionally **not** on the wire (they do not
 * affect geometry); reconstructed edges carry `multiplicity: 1`, `samples: []`.
 */
import type { InducedEdge } from '@meridian/abstraction';
import { asNodeId, type NodeId } from '@meridian/graph-core';
import type { Point, Rect, Size } from '../coords.js';
import type { LayoutHints, LayoutInput, LayoutResult } from '../types.js';

const ZERO_SIZE: Size = { width: 0, height: 0 };

// --------------------------------------------------------------- index table

/** The `index ↔ NodeId` table the host maintains for one cut (ADR-0017). Built
 * once per cut from `cut.members` (already ascending), reused across deltas. */
export interface IndexTable {
  /** `index → NodeId`; identical to `cut.members` (ascending). */
  readonly ids: readonly NodeId[];
  /** `NodeId → index`. */
  readonly index: ReadonlyMap<NodeId, number>;
  /** Fixed placeholder width so `placeholder(i)` lex-order === index order. */
  readonly width: number;
}

/** Build the `index ↔ NodeId` table for a cut's ascending member list. */
export function buildIndexTable(members: readonly NodeId[]): IndexTable {
  const index = new Map<NodeId, number>();
  members.forEach((m, i) => index.set(m, i));
  const width = Math.max(1, String(Math.max(0, members.length - 1)).length);
  return { ids: members, index, width };
}

/** The order-preserving placeholder id for index `i` at a fixed `width`. */
export function placeholderId(i: number, width: number): NodeId {
  return asNodeId(String(i).padStart(width, '0'));
}

// --------------------------------------------------------------- wire request

/** A `LayoutInput` (+ optional `prev`) encoded as transferable typed arrays
 * (ADR-0017 request table). Header fields are cloned; the typed arrays move. */
export interface WireRequest {
  readonly requestId: number;
  readonly providerId: string;
  readonly N: number;
  /** `Float64Array(2N)` = `[w₀,h₀,w₁,h₁,…]`. */
  readonly sizes: Float64Array;
  /** `Uint32Array(2E)` = `[srcIdx,dstIdx,…]`. */
  readonly edges: Uint32Array;
  /** `Float64Array(E)` edge weights. */
  readonly edgeWeights: Float64Array;
  /** `Uint32Array(E)` interned kind-ids into {@link kindTable}. */
  readonly edgeKinds: Uint32Array;
  /** Interned kind strings, cloned once. */
  readonly kindTable: readonly string[];
  /** `Int32Array(N)` compound parent index or `−1` for a root. */
  readonly parents: Int32Array;
  /** Small plain object (cloned; not hot). */
  readonly hints: LayoutHints;
  /** Whether {@link prev}/{@link prevMask} carry a warm-start layout. */
  readonly hasPrev: boolean;
  /** `Float64Array(4N)` `[x,y,w,h,…]` in the same index space (warm-start). */
  readonly prev: Float64Array;
  /** `Uint8Array(N)` presence mask for {@link prev}. */
  readonly prevMask: Uint8Array;
}

/** The transferables (backing buffers) of a {@link WireRequest}, for Comlink's
 * `transfer` list — a zero-copy move, not a structured clone. Typed as
 * `ArrayBufferLike[]` to keep this a core-law module (no DOM `Transferable`). */
export function requestTransfer(req: WireRequest): ArrayBufferLike[] {
  return [
    req.sizes.buffer,
    req.edges.buffer,
    req.edgeWeights.buffer,
    req.edgeKinds.buffer,
    req.parents.buffer,
    req.prev.buffer,
    req.prevMask.buffer,
  ];
}

/**
 * Encode a `LayoutInput` (+ optional `prev`, in the same index space) into a
 * {@link WireRequest}. `parents` is emitted all-`−1` (compound nesting is a 4D
 * concern; the field exists for elk). O(N + E) main-thread work — the only
 * per-request main cost, amortized by the cached {@link IndexTable}.
 */
export function encodeRequest(
  requestId: number,
  providerId: string,
  input: LayoutInput,
  table: IndexTable,
  prev?: LayoutResult,
): WireRequest {
  const N = table.ids.length;
  const sizes = new Float64Array(2 * N);
  for (let i = 0; i < N; i++) {
    const s = input.sizes.get(table.ids[i]!) ?? ZERO_SIZE;
    sizes[2 * i] = s.width;
    sizes[2 * i + 1] = s.height;
  }

  // Intern kinds; drop edges whose endpoints are not both members (defensive).
  const kindIds = new Map<string, number>();
  const kindTable: string[] = [];
  const srcDst: number[] = [];
  const weights: number[] = [];
  const kinds: number[] = [];
  for (const e of input.edges) {
    const a = table.index.get(e.src);
    const b = table.index.get(e.dst);
    if (a === undefined || b === undefined) continue;
    let kindId = kindIds.get(e.kind);
    if (kindId === undefined) {
      kindId = kindTable.length;
      kindIds.set(e.kind, kindId);
      kindTable.push(e.kind);
    }
    srcDst.push(a, b);
    weights.push(e.weight);
    kinds.push(kindId);
  }
  const edges = Uint32Array.from(srcDst);
  const edgeWeights = Float64Array.from(weights);
  const edgeKinds = Uint32Array.from(kinds);
  const parents = new Int32Array(N).fill(-1);

  const hasPrev = prev !== undefined;
  const prevArr = new Float64Array(hasPrev ? 4 * N : 0);
  const prevMask = new Uint8Array(hasPrev ? N : 0);
  if (prev !== undefined) {
    for (let i = 0; i < N; i++) {
      const r = prev.positions.get(table.ids[i]!);
      if (r === undefined) continue;
      prevMask[i] = 1;
      prevArr[4 * i] = r.x;
      prevArr[4 * i + 1] = r.y;
      prevArr[4 * i + 2] = r.width;
      prevArr[4 * i + 3] = r.height;
    }
  }

  return {
    requestId,
    providerId,
    N,
    sizes,
    edges,
    edgeWeights,
    edgeKinds,
    kindTable,
    parents,
    hints: input.hints,
    hasPrev,
    prev: prevArr,
    prevMask,
  };
}

/**
 * Reconstruct the worker-side `{ input, prev }` from a {@link WireRequest},
 * keyed on order-preserving placeholder ids. The reconstructed `cut` carries
 * only `members` (all a provider reads); `prev` (if present) carries only
 * `positions` and no `edgeRoutes` (the wire does not transfer prev edges — see
 * the module note and the 4C report).
 */
export function decodeRequest(req: WireRequest): {
  input: LayoutInput;
  prev: LayoutResult | undefined;
} {
  const N = req.N;
  const width = Math.max(1, String(Math.max(0, N - 1)).length);
  const members: NodeId[] = new Array(N);
  const sizeMap = new Map<NodeId, Size>();
  for (let i = 0; i < N; i++) {
    const id = placeholderId(i, width);
    members[i] = id;
    sizeMap.set(id, { width: req.sizes[2 * i]!, height: req.sizes[2 * i + 1]! });
  }

  const E = req.edgeWeights.length;
  const edges: InducedEdge[] = new Array(E);
  for (let j = 0; j < E; j++) {
    const src = placeholderId(req.edges[2 * j]!, width);
    const dst = placeholderId(req.edges[2 * j + 1]!, width);
    edges[j] = {
      src,
      dst,
      kind: req.kindTable[req.edgeKinds[j]!] ?? '',
      weight: req.edgeWeights[j]!,
      multiplicity: 1,
      samples: [],
    };
  }

  const input: LayoutInput = {
    cut: { level: 0, members, trace: new Map(), coverage: { leaves: 0, coveredLeaves: 0, covers: true } },
    edges,
    sizes: sizeMap,
    hints: req.hints,
  };

  let prev: LayoutResult | undefined;
  if (req.hasPrev) {
    const positions = new Map<NodeId, Rect>();
    for (let i = 0; i < N; i++) {
      if (req.prevMask[i] !== 1) continue;
      positions.set(members[i]!, {
        x: req.prev[4 * i]!,
        y: req.prev[4 * i + 1]!,
        width: req.prev[4 * i + 2]!,
        height: req.prev[4 * i + 3]!,
      });
    }
    prev = { positions, bounds: { x: 0, y: 0, width: 0, height: 0 }, stability: 1 };
  }

  return { input, prev };
}

// -------------------------------------------------------------- wire response

/** A `LayoutResult` encoded for the return trip (ADR-0017 response table).
 * `edgeOffsets`/`edgePoints` are the CSR polyline encoding (empty ⇒ straight
 * lines); `bounds`/`stability` ride in the header. */
export interface WireResponse {
  readonly requestId: number;
  /** `Float64Array(4N)` `[x,y,w,h,…]` per index (a `Rect`, ADR-0015). */
  readonly positions: Float64Array;
  /** `Uint32Array(E+1)` CSR offsets into {@link edgePoints}; `[o[e], o[e+1])`
   * bounds edge `e`'s points. All-equal ⇒ no routes. */
  readonly edgeOffsets: Uint32Array;
  /** `Float64Array` of concatenated `[x,y,…]` polyline points. */
  readonly edgePoints: Float64Array;
  /** Tight world-space AABB (ADR-0015). */
  readonly bounds: Rect;
  /** ADR-0016 score (recomputable, so verifiable). */
  readonly stability: number;
}

/** Transferables of a {@link WireResponse} (ownership returned to main). */
export function responseTransfer(res: WireResponse): ArrayBufferLike[] {
  return [res.positions.buffer, res.edgeOffsets.buffer, res.edgePoints.buffer];
}

/** The `"src→dst→kind"` identity of a reconstructed edge (ADR-0013/0015). */
function edgeKey(e: InducedEdge): string {
  return `${e.src}→${e.dst}→${e.kind}`;
}

/**
 * Encode a provider's `LayoutResult` (computed over placeholder ids) plus the
 * request's reconstructed `edges` into a {@link WireResponse}. Positions are
 * written in index order; edge routes are laid out in the request's edge order
 * as CSR so the host re-keys them by real `"src→dst→kind"` identity.
 */
export function encodeResponse(
  requestId: number,
  result: LayoutResult,
  input: LayoutInput,
): WireResponse {
  const members = input.cut.members;
  const N = members.length;
  const width = Math.max(1, String(Math.max(0, N - 1)).length);
  const positions = new Float64Array(4 * N);
  for (let i = 0; i < N; i++) {
    const r = result.positions.get(placeholderId(i, width));
    if (r === undefined) continue;
    positions[4 * i] = r.x;
    positions[4 * i + 1] = r.y;
    positions[4 * i + 2] = r.width;
    positions[4 * i + 3] = r.height;
  }

  const routes = result.edgeRoutes;
  const E = input.edges.length;
  const edgeOffsets = new Uint32Array(E + 1);
  const pts: number[] = [];
  for (let j = 0; j < E; j++) {
    edgeOffsets[j] = pts.length / 2;
    const route = routes?.get(edgeKey(input.edges[j]!));
    if (route !== undefined && route.length >= 2) {
      for (const p of route) pts.push(p.x, p.y);
    }
  }
  edgeOffsets[E] = pts.length / 2;
  const edgePoints = Float64Array.from(pts);

  return { requestId, positions, edgeOffsets, edgePoints, bounds: result.bounds, stability: result.stability };
}

/**
 * Re-hydrate a {@link WireResponse} into a `LayoutResult` over the real
 * `NodeId`s (via the {@link IndexTable}). **O(N) here, but the caller wraps
 * this in a lazy array-backed view (`decodeResponseLazy`) on the hot path** to
 * keep the boundary O(1) (ADR-0017's 4ms guarantee). `edges` supplies the real
 * `"src→dst→kind"` keys for any CSR routes.
 */
export function decodeResponse(
  res: WireResponse,
  table: IndexTable,
  edges: readonly InducedEdge[],
): LayoutResult {
  const positions = new Map<NodeId, Rect>();
  const N = table.ids.length;
  for (let i = 0; i < N; i++) {
    positions.set(table.ids[i]!, {
      x: res.positions[4 * i]!,
      y: res.positions[4 * i + 1]!,
      width: res.positions[4 * i + 2]!,
      height: res.positions[4 * i + 3]!,
    });
  }
  const edgeRoutes = decodeRoutes(res, edges);
  const result: LayoutResult = { positions, bounds: res.bounds, stability: res.stability };
  return edgeRoutes === undefined ? result : { ...result, edgeRoutes };
}

/** Re-key the CSR routes by real `"src→dst→kind"`; `undefined` if none. */
function decodeRoutes(
  res: WireResponse,
  edges: readonly InducedEdge[],
): ReadonlyMap<string, readonly Point[]> | undefined {
  const E = edges.length;
  if (res.edgePoints.length === 0) return undefined;
  const routes = new Map<string, readonly Point[]>();
  for (let j = 0; j < E; j++) {
    const start = res.edgeOffsets[j]!;
    const end = res.edgeOffsets[j + 1]!;
    if (end <= start) continue;
    const poly: Point[] = [];
    for (let k = start; k < end; k++) poly.push({ x: res.edgePoints[2 * k]!, y: res.edgePoints[2 * k + 1]! });
    routes.set(`${edges[j]!.src}→${edges[j]!.dst}→${edges[j]!.kind}`, poly);
  }
  return routes.size === 0 ? undefined : routes;
}

/**
 * The **lazy, array-backed** re-hydration (ADR-0017's 4ms guarantee). Returns a
 * `LayoutResult` whose `positions` is a `ReadonlyMap`-shaped view over the
 * returned `Float64Array` and the cached {@link IndexTable}: `get(id)` slices
 * four lanes on demand, so steady-state main-thread work per response is O(1)
 * (no N-entry `Map` is materialized). `edgeRoutes` is decoded eagerly only when
 * routes are present (grid/tree emit none, so it stays `undefined`).
 */
export function decodeResponseLazy(
  res: WireResponse,
  table: IndexTable,
  edges: readonly InducedEdge[],
): LayoutResult {
  const positions = new ArrayBackedPositions(res.positions, table);
  const edgeRoutes = decodeRoutes(res, edges);
  const base = { positions, bounds: res.bounds, stability: res.stability };
  return edgeRoutes === undefined ? base : { ...base, edgeRoutes };
}

/** A `ReadonlyMap<NodeId, Rect>` view backed by a `Float64Array(4N)` and the
 * `index ↔ NodeId` table — `get`/iteration slice lanes on demand (ADR-0017). */
class ArrayBackedPositions implements ReadonlyMap<NodeId, Rect> {
  constructor(
    private readonly buf: Float64Array,
    private readonly table: IndexTable,
  ) {}

  get size(): number {
    return this.table.ids.length;
  }

  private rectAt(i: number): Rect {
    return {
      x: this.buf[4 * i]!,
      y: this.buf[4 * i + 1]!,
      width: this.buf[4 * i + 2]!,
      height: this.buf[4 * i + 3]!,
    };
  }

  get(id: NodeId): Rect | undefined {
    const i = this.table.index.get(id);
    return i === undefined ? undefined : this.rectAt(i);
  }

  has(id: NodeId): boolean {
    return this.table.index.has(id);
  }

  forEach(cb: (value: Rect, key: NodeId, map: ReadonlyMap<NodeId, Rect>) => void, thisArg?: unknown): void {
    this.table.ids.forEach((id, i) => cb.call(thisArg, this.rectAt(i), id, this));
  }

  *entries(): MapIterator<[NodeId, Rect]> {
    for (let i = 0; i < this.table.ids.length; i++) yield [this.table.ids[i]!, this.rectAt(i)];
  }

  *keys(): MapIterator<NodeId> {
    yield* this.table.ids;
  }

  *values(): MapIterator<Rect> {
    for (let i = 0; i < this.table.ids.length; i++) yield this.rectAt(i);
  }

  [Symbol.iterator](): MapIterator<[NodeId, Rect]> {
    return this.entries();
  }
}
