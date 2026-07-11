/**
 * The `d3-force` provider (ROADMAP Phase 4 §3, §9; subphase 4E): an organic,
 * force-directed engine over **d3-force** (pure JS, isomorphic — no DOM, no
 * `node:*`, no Web Worker), for the cluster-ish / tangled cuts the layered
 * engine handles poorly (ADR-0018 rules 5/6). It turns a cut + induced edges
 * into world-space positions by relaxing a spring/charge simulation, with:
 *
 * - **Seeded determinism (I6; ROADMAP §9b).** Force layout is the one
 *   stochastic provider, so its randomness is a *seeded* PRNG
 *   (`LayoutHints.seed`, default {@link DEFAULT_SEED}): the simulation's
 *   `randomSource` is a deterministic mulberry32 stream, and initial placement
 *   is d3's index-based phyllotaxis (also deterministic). Same input ⇒
 *   byte-identical positions — a **test**, not a hope
 *   (`test/d3-force.test.ts`). Because the simulation computes purely on member
 *   *indices*, sizes, edge index-pairs, and the seed — never on the `NodeId`
 *   strings — the worker (placeholder ids) reproduces the main thread's
 *   geometry byte-for-byte (the worker-parity test / corpus goldens).
 * - **Warm-start stability (ADR-0016 mechanism, folded back in 4E).** When
 *   `prev` is supplied, each **persistent** node is *held at its prior position*
 *   (d3's `fx`/`fy` fixed-position hints) through a short, reduced-`alpha`
 *   relaxation, while **new** nodes — pre-seeded at their persistent
 *   neighbours' centroid — settle into the fixed structure; a final centroid
 *   alignment removes any residual drift. Pure warm-start + reduced alpha alone
 *   reflowed the graph (a ring-delta scored 0.32, an 8-node-delta sequence
 *   0.88 — below the 0.90 floor), exactly as 4D found pure elk position hints
 *   insufficient (0.72) and added centroid alignment; holding persistent nodes
 *   is the force analogue and is a *stronger* honouring of "nodes must not
 *   teleport." The score is the pure `stabilityScore`, recomputed and
 *   CI-verified — a provider cannot self-report a lie.
 * - **Cooperative cancellation (ADR-0017).** The tick loop checks the
 *   `AbortSignal` **every tick** and abandons the simulation promptly (throwing
 *   an `AbortError`) — d3-force is the one provider that meaningfully can.
 *
 * Edge routes are straight center-to-center lines (v1, ROADMAP §9c), so
 * `edgeRoutes` is omitted — consistent with `grid`/`tree`.
 *
 * Core-law: d3-force is an *engine* dependency (pure JS, isomorphic), allowed
 * for `layout/src` alongside comlink and elkjs in the depcruiser config. No DOM,
 * no domain words, no AI.
 */
import type { NodeId } from '@meridian/graph-core';
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force';
import type { SimulationLinkDatum, SimulationNodeDatum } from 'd3-force';
import type { Point, Rect, Size } from './coords.js';
import { boundsOf, DEFAULT_SPACING, EMPTY_BOUNDS } from './geometry.js';
import { stabilityScore } from './stability.js';
import type { LayoutInput, LayoutProvider, LayoutResult } from './types.js';

const ZERO_SIZE: Size = { width: 0, height: 0 };

/** Default PRNG seed when `hints.seed` is unset — the layout is still fully
 * deterministic, just with a fixed stream (I6). */
export const DEFAULT_SEED = 0x9e3779b9;

/**
 * Above this member count the simulation switches to a **bounded-budget** mode
 * to stay inside the 10k-convergence budget (benchmarks/budgets.json): the
 * O(Σdeg) collision force is dropped (it rebuilds a quadtree every tick), the
 * Barnes–Hut approximation loosens ({@link LARGE_THETA}), and the iteration
 * count is capped at {@link MAX_TICKS_LARGE}. Force layouts are always
 * iteration-budget-limited at scale; small corpus cuts (all the human-reviewed
 * SVG goldens) keep the accurate settings. The threshold is a function of `N`,
 * so the choice stays deterministic (I6).
 */
export const LARGE_N = 2000;

/** Barnes–Hut accuracy parameter above {@link LARGE_N} (d3 default is `0.9`;
 * looser = faster, adequate for a scale layout that is not pixel-reviewed). */
export const LARGE_THETA = 1.7;

/** Iteration cap above {@link LARGE_N} — most force structure forms early, and
 * this bounds the 10k-node worst case under the convergence budget. */
export const MAX_TICKS_LARGE = 60;

/**
 * When a caller supplies an `AbortSignal`, the tick loop yields a macrotask
 * every this-many ticks so an out-of-band cancel can actually be *delivered*
 * (in the worker, the ADR-0017 control-port message; on the main thread, the
 * caller's own `abort()`) before the next tick's check — the mechanism behind
 * "d3-force checks every tick, abandons the sim." Yielding is skipped entirely
 * when there is no signal (the goldens / benchmark path), so it costs nothing
 * there and never perturbs the computed geometry.
 */
export const YIELD_EVERY = 8;

/** Warm-start starting `alpha` (ADR-0016). Low, so the relaxation is a gentle
 * nudge that settles new nodes without re-flowing persistent ones. */
export const WARM_ALPHA = 0.3;

/** Warm-start velocity damping (d3 default is `0.4`). Higher = more damping =
 * persistent nodes move less — the stability lever. */
export const WARM_VELOCITY_DECAY = 0.6;

/** Warm-start iteration cap. New nodes are pre-seeded at their neighbours'
 * centroid and persistent nodes are held fixed, so few ticks settle the new
 * ones without disturbing the rest. */
export const WARM_TICKS = 40;

/** Yield one macrotask so pending message-port / timer events are delivered.
 * Uses the global `setTimeout` (isomorphic — no `node:*`, present in browser,
 * worker, and Node). */
function yieldTask(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * A deterministic 32-bit PRNG (mulberry32) seeded from an integer. Uniform in
 * `[0,1)`. Used as d3-force's `randomSource` so every stochastic step
 * (jiggle of coincident nodes) is reproducible.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One simulation node: a member's index space, its size, and (mutated by the
 * sim) its center. `x`/`y` seed from `prev` for warm-start (ADR-0016). */
interface ForceNode extends SimulationNodeDatum {
  readonly i: number;
  readonly r: number;
}

/** Build an `AbortError` (`DOMException` where available; a named `Error`
 * otherwise). Inlined to keep this provider free of the worker/comlink module
 * (which imports every provider — an import cycle). */
function abortError(): Error {
  try {
    return new DOMException('Aborted', 'AbortError');
  } catch {
    const e = new Error('Aborted');
    e.name = 'AbortError';
    return e;
  }
}

/** Bounding-circle radius of a box (half its diagonal). Zero for a point-rect. */
function radiusOf(s: Size): number {
  return Math.hypot(s.width, s.height) / 2;
}

/** The number of ticks that decays `alpha` to `alphaMin` at `alphaDecay` — d3's
 * own convergence schedule, made explicit so the loop can cancel per tick. */
function tickCount(alpha: number, alphaMin: number, alphaDecay: number): number {
  return Math.ceil(Math.log(alphaMin / alpha) / Math.log(1 - alphaDecay));
}

/** The mean prev→current displacement over persistent members (centroid
 * alignment); `undefined` when there is no prior layout to anchor to. */
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

export const d3ForceProvider: LayoutProvider = {
  id: 'd3-force',
  capabilities: { incremental: true, compound: false, deterministic: true },
  async compute(input: LayoutInput, prev?: LayoutResult, signal?: AbortSignal): Promise<LayoutResult> {
    const members = input.cut.members;
    const N = members.length;
    if (N === 0) {
      return { positions: new Map<NodeId, Rect>(), bounds: EMPTY_BOUNDS, stability: 1 };
    }
    if (signal?.aborted) throw abortError();

    const spacing = input.hints.spacing !== undefined && input.hints.spacing >= 0 ? input.hints.spacing : DEFAULT_SPACING;
    const seed = input.hints.seed !== undefined ? input.hints.seed : DEFAULT_SEED;
    const random = mulberry32(seed);

    const prevPositions = prev?.positions;
    const warm = prevPositions !== undefined && prevPositions.size > 0;

    // Build the simulation nodes in member-index order and record which carry a
    // prior position (persistent) vs. are new this delta.
    const index = new Map<NodeId, number>();
    let sumR = 0;
    const nodes: ForceNode[] = new Array(N);
    const priorCenter: (Point | undefined)[] = new Array(N);
    for (let i = 0; i < N; i++) {
      const id = members[i]!;
      index.set(id, i);
      const s = input.sizes.get(id) ?? ZERO_SIZE;
      const r = radiusOf(s);
      sumR += r;
      const node: ForceNode = { i, r };
      const p = prevPositions?.get(id);
      if (p !== undefined) {
        const c = { x: p.x + p.width / 2, y: p.y + p.height / 2 };
        priorCenter[i] = c;
        node.x = c.x;
        node.y = c.y;
        // Hold persistent nodes fixed through the warm relaxation (ADR-0016).
        node.fx = c.x;
        node.fy = c.y;
      }
      nodes[i] = node;
    }
    const meanR = sumR / N;

    // Force-field scale: distances/strengths scale with node size + spacing so
    // the layout reads at the CLI's presentation sizes (ADR-0015 world units).
    const linkDistance = 2 * meanR + spacing * 2;
    const charge = -(meanR * 4 + spacing * 6);
    const large = N > LARGE_N;

    // Links over member index-pairs (self-loops and non-members dropped). The
    // default id accessor is `node.index`, which d3 sets to the array position.
    // Also collect an undirected neighbour list for warm-start seeding.
    const links: SimulationLinkDatum<ForceNode>[] = [];
    const neighbours: number[][] = warm ? Array.from({ length: N }, () => []) : [];
    for (const e of input.edges) {
      const a = index.get(e.src);
      const b = index.get(e.dst);
      if (a === undefined || b === undefined || a === b) continue;
      links.push({ source: a, target: b });
      if (warm) {
        neighbours[a]!.push(b);
        neighbours[b]!.push(a);
      }
    }

    // Warm-start seeding (ADR-0016): a **new** node (no prior position) starts
    // at the centroid of its persistent neighbours, so it appears where it
    // belongs instead of flying in from d3's phyllotaxis and disturbing the
    // nodes that stayed. New nodes with no placed neighbour keep phyllotaxis.
    if (warm) {
      for (let i = 0; i < N; i++) {
        if (priorCenter[i] !== undefined) continue;
        let sx = 0;
        let sy = 0;
        let count = 0;
        for (const j of neighbours[i]!) {
          const c = priorCenter[j];
          if (c === undefined) continue;
          sx += c.x;
          sy += c.y;
          count++;
        }
        if (count > 0) {
          nodes[i]!.x = sx / count;
          nodes[i]!.y = sy / count;
        }
      }
    }

    // Seeded initial placement for every still-unplaced node (all nodes in a
    // cold layout; only orphan new nodes in a warm one). A seeded phyllotaxis:
    // the radius grows with the index (so points never coincide) and the angle
    // is drawn from the seeded PRNG (so the seed genuinely shapes the layout,
    // deterministically per seed — the I6 test). Consumed in index order, so
    // the worker (placeholder ids) draws the same stream as the main thread.
    for (let i = 0; i < N; i++) {
      const node = nodes[i]!;
      if (node.x !== undefined && Number.isFinite(node.x)) continue;
      const angle = random() * 2 * Math.PI;
      const radius = linkDistance * Math.sqrt(0.5 + i);
      node.x = radius * Math.cos(angle);
      node.y = radius * Math.sin(angle);
    }

    const sim = forceSimulation<ForceNode>(nodes).stop();
    sim.randomSource(random);
    const manyBody = forceManyBody<ForceNode>().strength(charge);
    if (large) manyBody.theta(LARGE_THETA);
    sim.force('charge', manyBody).force(
      'link',
      forceLink<ForceNode, SimulationLinkDatum<ForceNode>>(links).distance(
        (l) => linkDistance + (l.source as ForceNode).r + (l.target as ForceNode).r,
      ),
    );
    // Cold layout only: weak centering at the origin, so disconnected components
    // neither drift apart nor fly off. In warm mode the persistent nodes are
    // already pinned (`fx`/`fy`) to their prior world place, so no centering is
    // applied — new nodes settle purely against the fixed structure via their
    // links, which is what keeps the small-delta stability above the 0.90 floor.
    if (!warm) {
      sim.force('x', forceX<ForceNode>(0).strength(0.02)).force('y', forceY<ForceNode>(0).strength(0.02));
    }
    if (!large) {
      sim.force('collide', forceCollide<ForceNode>((d) => d.r + spacing / 2));
    }

    // Warm-start relaxes **gently** so persistent nodes hold their world place
    // (ADR-0016 stability): a low starting `alpha`, extra velocity damping, and
    // a capped tick count let a pre-seeded new node settle without re-flowing
    // the graph. A cold layout runs the full decay from `alpha = 1`.
    if (warm) sim.velocityDecay(WARM_VELOCITY_DECAY);
    const alphaStart = warm ? WARM_ALPHA : 1;
    const alphaMin = sim.alphaMin();
    const alphaDecay = sim.alphaDecay();
    sim.alpha(alphaStart);
    const scheduled = tickCount(alphaStart, alphaMin, alphaDecay);
    const ticks = warm
      ? Math.min(scheduled, WARM_TICKS)
      : large
        ? Math.min(scheduled, MAX_TICKS_LARGE)
        : scheduled;
    for (let t = 0; t < ticks; t++) {
      if (signal?.aborted) {
        sim.stop();
        throw abortError();
      }
      sim.tick();
      // Cooperative cancellation (ADR-0017): only when a signal exists, yield a
      // macrotask periodically so an out-of-band cancel can land between ticks.
      if (signal !== undefined && (t + 1) % YIELD_EVERY === 0) await yieldTask();
    }
    sim.stop();

    // Convert settled centers → world-space Rects (min-corner, ADR-0015).
    let positions = new Map<NodeId, Rect>();
    for (let i = 0; i < N; i++) {
      const id = members[i]!;
      const s = input.sizes.get(id) ?? ZERO_SIZE;
      const node = nodes[i]!;
      const cx = Number.isFinite(node.x) ? (node.x as number) : 0;
      const cy = Number.isFinite(node.y) ? (node.y as number) : 0;
      positions.set(id, { x: cx - s.width / 2, y: cy - s.height / 2, width: s.width, height: s.height });
    }

    // Centroid alignment to `prev` (ADR-0016 mechanism, as elk-layered): remove
    // global translation so persistent nodes keep their world place; the pure
    // score is still recomputed independently by CI.
    const offset = anchorOffset(positions, prevPositions);
    if (offset !== undefined) {
      const shifted = new Map<NodeId, Rect>();
      for (const [id, r] of positions) shifted.set(id, { x: r.x + offset.x, y: r.y + offset.y, width: r.width, height: r.height });
      positions = shifted;
    }

    const bounds = boundsOf(positions.values());
    const draft: LayoutResult = { positions, bounds, stability: 1 };
    const { stability } = stabilityScore(prev, draft, input.hints);
    return { ...draft, stability };
  },
};
