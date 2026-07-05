/**
 * The LOD resolver (ROADMAP Phase 3 §5; ADR-0012 + ADR-0014). A single pure,
 * deterministic function answering *"given zoom `z`, focus `F`, overrides and a
 * node budget, exactly which nodes and edges are visible, and why?"*.
 *
 *   resolve(req) → { cut, inducedEdges, cappedEdges, frontier, provenance }
 *
 * The pipeline, per the ADRs:
 *  1. **Zoom → base level** with hysteresis (`zoom-policy.ts`, ADR-0012).
 *  2. **Override classification.** Overrides on removed nodes are ignored and
 *     traced (`removed`); overrides shadowed under a pinned ancestor are ignored
 *     and traced (`shadowed`) — never thrown (ADR-0012).
 *  3. **Descent** partitions each containment tree into a covering antichain
 *     (I5) under deepest-override-wins precedence: a `pin`/`expand` on a
 *     descendant pierces a `collapse`/level decision on an ancestor.
 *  4. **Budget degradation** (ADR-0014): while over `maxNodes`, greedily roll
 *     the lowest-salience frontier up one containment level, protecting pins,
 *     expands and the focus path; coverage (I5) wins over budget — a cut that
 *     cannot be shrunk further is emitted with `budget-exceeded` in the trace.
 *  5. **Induced edges** (ADR-0013): the complete aggregation plus the labeled
 *     fan-out cap.
 *
 * Pure over an immutable snapshot (P8); imports only graph-core/graph-store
 * (§20). No `Date.now`, no randomness — recency is data (`core:updated-at`).
 */
import {
  detailGraphOf,
  type GraphId,
  type GraphSpace,
  type NodeId,
  type SemanticGraph,
} from '@meridian/graph-core';
import {
  type Cut,
  type CutMember,
  type CutReason,
} from './cut.js';
import { buildForestIndex, isLeafNode, type ForestIndex } from './forest-index.js';
import { forestRootGraphs } from './forest.js';
import {
  aggregateEdges,
  capFanOut,
  FANOUT_CAP,
  type CappedFanOut,
  type InducedEdge,
} from './induced.js';
import type { LevelChain } from './level-chain.js';
import { computeSalience, type SalienceWeights } from './salience.js';
import {
  assertValidPolicy,
  levelForZoom,
  type Budget,
  type ZoomPolicy,
} from './zoom-policy.js';

/** Per-node local override of the descent (ADR-0012). */
export type OverrideKind = 'pin' | 'expand' | 'collapse';

/** The per-request LOD inputs (ROADMAP §5). `space`, `chain` and `policy` are
 * bound to the {@link LodResolver}; this carries the varying state. */
export interface LodRequest {
  /** Zoom scalar in `[0,1]`; `0` coarsest, `1` finest (ADR-0012). */
  readonly zoom: number;
  /** Drill-in anchor. Inert for the mapping in v1; protects its path from
   * budget collapse (ADR-0014) and is recorded in the trace (ADR-0012). */
  readonly focus?: NodeId;
  /** Per-node pin/expand/collapse overrides (deepest-wins). */
  readonly overrides: ReadonlyMap<NodeId, OverrideKind>;
  /** Overrides this budget rather than the policy's, when present (ADR-0014). */
  readonly viewportHint?: Budget;
  /** The prior base level, threaded in so hysteresis stays pure (ADR-0012). */
  readonly prevLevel?: number;
}

/** An override that could not be honored, with a located reason (ADR-0012):
 * `removed` (node absent from the space) or `shadowed` (unreachable under a
 * pinned ancestor). Never a thrown error. */
export interface IgnoredOverride {
  readonly node: NodeId;
  readonly kind: OverrideKind;
  readonly reason: 'removed' | 'shadowed';
}

/** One budget-driven rollup (ADR-0014): `node` replaced the frontier
 * `replaced` because that frontier held the least-salient region. */
export interface BudgetCollapse {
  readonly node: NodeId;
  readonly replaced: readonly NodeId[];
  /** The losing (minimum) salience among `replaced` — the collapse cost. */
  readonly losingSalience: number;
}

/** Budget provenance (ADR-0014). `exceeded` is the coverage-wins flag: the cut
 * could not be shrunk to `maxNodes` without hiding a forced-open node. */
export interface BudgetTrace {
  readonly maxNodes: number;
  readonly collapsed: readonly BudgetCollapse[];
  readonly exceeded: boolean;
}

/** The full "why is each node visible, and why this cut?" provenance
 * (ADR-0012/0014). Every inclusion has one located reason; every dropped
 * override and every budget rollup is recorded. */
export interface CutTrace {
  /** The requested zoom scalar (echoed for provenance). */
  readonly zoom: number;
  /** The hysteresis-free nominal level `z` fell in. */
  readonly nominalLevel: number;
  /** The base level actually used after hysteresis. */
  readonly level: number;
  /** The recorded focus (inert for the mapping in v1). */
  readonly focus?: NodeId;
  /** Emitted node → its single inclusion reason. */
  readonly reasons: ReadonlyMap<NodeId, CutReason>;
  /** Overrides that were dropped, with located reasons. */
  readonly ignoredOverrides: readonly IgnoredOverride[];
  /** Budget provenance, present only when a budget was applied. */
  readonly budget?: BudgetTrace;
}

/** The resolver's output (ROADMAP §5). */
export interface LodResult {
  /** The visible antichain (covers every leaf exactly once, I5). */
  readonly cut: Cut;
  /** The complete induced-edge aggregation (ADR-0013), sorted, deduped. */
  readonly inducedEdges: readonly InducedEdge[];
  /** The labeled fan-out cap over `inducedEdges` (presentation; ADR-0013). */
  readonly cappedEdges: CappedFanOut;
  /** Expandable = descendable members; collapsible = members whose parent has
   * no other reason to stay open (ADR-0012). */
  readonly frontier: { readonly expandable: readonly NodeId[]; readonly collapsible: readonly NodeId[] };
  /** Why each node is in/out, why this cut (ADR-0012/0014). */
  readonly provenance: CutTrace;
}

/** Options bound to a resolver (salience weights are P6-tunable, ADR-0014). */
export interface LodResolverOptions {
  readonly salienceWeights?: SalienceWeights;
}

function compareIds(a: NodeId, b: NodeId): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// --------------------------------------------------------------- min-heap

/** A tiny deterministic binary heap of collapse candidates, ordered by
 * `(cost asc, nodeId asc)` (ADR-0014 tie-break, I6). */
class CandidateHeap {
  private readonly items: { node: NodeId; cost: number }[] = [];

  private less(a: { node: NodeId; cost: number }, b: { node: NodeId; cost: number }): boolean {
    return a.cost < b.cost || (a.cost === b.cost && a.node < b.node);
  }

  push(node: NodeId, cost: number): void {
    const items = this.items;
    items.push({ node, cost });
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.less(items[i]!, items[parent]!)) {
        [items[i], items[parent]] = [items[parent]!, items[i]!];
        i = parent;
      } else break;
    }
  }

  pop(): { node: NodeId; cost: number } | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let smallest = i;
        if (l < items.length && this.less(items[l]!, items[smallest]!)) smallest = l;
        if (r < items.length && this.less(items[r]!, items[smallest]!)) smallest = r;
        if (smallest === i) break;
        [items[i], items[smallest]] = [items[smallest]!, items[i]!];
        i = smallest;
      }
    }
    return top;
  }
}

// ------------------------------------------------------------- the resolver

/**
 * A resolver bound to one `(space, chain, policy)`. `resolve(req)` is a pure
 * deterministic function of the request (ADR-0012/0014). Construct once per
 * snapshot; the forest index is precomputed in the constructor.
 */
export class LodResolver {
  private readonly index: ForestIndex;
  private readonly weights?: SalienceWeights;

  constructor(
    private readonly space: GraphSpace,
    private readonly chain: LevelChain,
    private readonly policy: ZoomPolicy,
    options: LodResolverOptions = {},
  ) {
    assertValidPolicy(policy);
    this.index = buildForestIndex(space);
    this.weights = options.salienceWeights;
  }

  resolve(req: LodRequest): LodResult {
    const index = this.index;
    const { level: base, nominal } = levelForZoom(this.policy, this.chain, req.zoom, req.prevLevel);

    // --- 2. Classify overrides. ---------------------------------------------
    const ignored: IgnoredOverride[] = [];
    const valid = new Map<NodeId, OverrideKind>();
    for (const [node, kind] of req.overrides) {
      if (index.nodeOf.has(node)) valid.set(node, kind);
      else ignored.push({ node, kind, reason: 'removed' });
    }
    // Shadowed: any override strictly under a pinned ancestor is unreachable.
    const effective = new Map<NodeId, OverrideKind>();
    for (const [node, kind] of valid) {
      if (this.underPin(node, valid)) ignored.push({ node, kind, reason: 'shadowed' });
      else effective.set(node, kind);
    }

    // "Subtree strictly below n holds an effective pin/expand" — the pierce
    // predicate for deepest-override-wins (ADR-0012). Only needed when some
    // pin/expand exists; skipping it keeps the edgeless big-fan case O(1) here.
    let hasPinExpand = false;
    for (const k of effective.values()) if (k === 'pin' || k === 'expand') { hasPinExpand = true; break; }
    const pinExpandInclusive = hasPinExpand
      ? this.reverseFold((n, childHas) => {
          const ov = effective.get(n);
          return ov === 'pin' || ov === 'expand' || childHas;
        })
      : undefined;
    const opensBelow = (n: NodeId): boolean =>
      pinExpandInclusive !== undefined &&
      (index.children.get(n) ?? []).some((c) => pinExpandInclusive.get(c) === true);

    // --- 3. Descent → covering antichain with reasons. ----------------------
    const trace = new Map<NodeId, CutMember>();
    const emit = (id: NodeId, graph: GraphId, depth: number, reason: CutReason): void => {
      trace.set(id, { node: id, graph, depth, reason, coveredLeaves: index.subtreeLeaves.get(id) ?? 1 });
    };
    const visit = (graph: SemanticGraph, depth: number): void => {
      for (const node of graph.nodes.values()) {
        const id = node.id;
        const leaf = isLeafNode(index, id);
        const ov = effective.get(id);
        if (ov === 'pin') {
          emit(id, graph.id, depth, 'pin');
          continue;
        }
        if (ov === 'expand') {
          if (leaf) emit(id, graph.id, depth, 'leaf');
          else visit(detailGraphOf(this.space, node)!, depth + 1);
          continue;
        }
        if (ov === 'collapse') {
          if (!leaf && opensBelow(id)) visit(detailGraphOf(this.space, node)!, depth + 1);
          else emit(id, graph.id, depth, 'collapse');
          continue;
        }
        // No override (rules 4/5).
        if (leaf) {
          emit(id, graph.id, depth, 'leaf');
        } else if (depth < base || opensBelow(id)) {
          visit(detailGraphOf(this.space, node)!, depth + 1);
        } else {
          emit(id, graph.id, depth, depth === base ? 'level' : 'expand-parent');
        }
      }
    };
    for (const graph of forestRootGraphs(this.space)) visit(graph, 0);

    // --- 4. Budget degradation. ---------------------------------------------
    const budgetSpec = req.viewportHint ?? this.policy.budget;
    let budgetTrace: BudgetTrace | undefined;
    if (budgetSpec !== undefined) {
      budgetTrace = this.degrade(trace, budgetSpec, effective, req.focus);
    }

    // --- Assemble the cut. --------------------------------------------------
    const cut = this.assembleCut(base, trace);

    // --- 5. Induced edges. An edgeless forest induces nothing, so skip the
    // whole-forest cover walk (matters on the 1M-leaf fixture). ----------------
    const inducedEdges = index.hasEdges ? aggregateEdges(this.space, cut) : [];
    const cappedEdges = index.hasEdges
      ? capFanOut(inducedEdges, budgetSpec?.fanOut ?? FANOUT_CAP)
      : { edges: [], residuals: [] };

    // --- Frontier. ----------------------------------------------------------
    const memberSet = new Set(cut.members);
    const frontier = this.frontier(memberSet, effective, req.focus);

    const reasons = new Map<NodeId, CutReason>();
    for (const [id, member] of trace) reasons.set(id, member.reason);

    return {
      cut,
      inducedEdges,
      cappedEdges,
      frontier,
      provenance: {
        zoom: req.zoom,
        nominalLevel: nominal,
        level: base,
        ...(req.focus !== undefined ? { focus: req.focus } : {}),
        reasons,
        ignoredOverrides: ignored,
        ...(budgetTrace !== undefined ? { budget: budgetTrace } : {}),
      },
    };
  }

  // ------------------------------------------------------------- internals

  /** True when a strict ancestor of `node` carries a `pin` override. */
  private underPin(node: NodeId, overrides: ReadonlyMap<NodeId, OverrideKind>): boolean {
    let cur = this.index.parent.get(node);
    while (cur !== undefined) {
      if (overrides.get(cur) === 'pin') return true;
      cur = this.index.parent.get(cur);
    }
    return false;
  }

  /** Fold a boolean bottom-up over the forest: `f(node, anyChildTrue)`.
   * `index.nodes` is pre-order, so iterating in reverse visits children first. */
  private reverseFold(f: (node: NodeId, childHas: boolean) => boolean): Map<NodeId, boolean> {
    const out = new Map<NodeId, boolean>();
    const nodes = this.index.nodes;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i]!;
      let childHas = false;
      for (const c of this.index.children.get(n) ?? []) {
        if (out.get(c) === true) {
          childHas = true;
          break;
        }
      }
      out.set(n, f(n, childHas));
    }
    return out;
  }

  private assembleCut(level: number, trace: Map<NodeId, CutMember>): Cut {
    const members = [...trace.keys()].sort(compareIds);
    let coveredLeaves = 0;
    for (const m of trace.values()) coveredLeaves += m.coveredLeaves;
    const leaves = this.index.totalLeaves;
    return {
      level,
      members,
      trace,
      coverage: { leaves, coveredLeaves, covers: coveredLeaves === leaves },
    };
  }

  /**
   * Roll the lowest-salience frontier up one containment level until under
   * `maxNodes` or no legal rollup remains (ADR-0014). Mutates `trace` in place;
   * returns the budget provenance. A rollup is legal only when a node's whole
   * detail-child frontier is currently visible and none of it is protected
   * (pins, expands, focus path). Coverage wins: an irreducible over-budget cut
   * is emitted with `exceeded: true`.
   */
  private degrade(
    trace: Map<NodeId, CutMember>,
    budget: Budget,
    effective: ReadonlyMap<NodeId, OverrideKind>,
    focus: NodeId | undefined,
  ): BudgetTrace {
    const index = this.index;
    const collapsed: BudgetCollapse[] = [];
    if (trace.size <= budget.maxNodes) {
      return { maxNodes: budget.maxNodes, collapsed, exceeded: false };
    }

    // Protected nodes: effective pins/expands and the focus containment path.
    const protectedSet = new Set<NodeId>();
    for (const [node, kind] of effective) {
      if (kind === 'pin' || kind === 'expand') protectedSet.add(node);
    }
    if (focus !== undefined && index.nodeOf.has(focus)) {
      let cur: NodeId | undefined = focus;
      while (cur !== undefined) {
        protectedSet.add(cur);
        cur = index.parent.get(cur);
      }
    }
    const protectedBelow =
      protectedSet.size > 0 ? this.reverseFold((n, childHas) => protectedSet.has(n) || childHas) : undefined;

    // Salience over the removable universe = members ∪ all their ancestors.
    const memberSet = new Set(trace.keys());
    const universe = new Set<NodeId>(memberSet);
    for (const m of memberSet) {
      let cur = index.parent.get(m);
      while (cur !== undefined && !universe.has(cur)) {
        universe.add(cur);
        cur = index.parent.get(cur);
      }
    }
    const salience = computeSalience(index, universe, this.weights);

    const eligible = (p: NodeId): { ok: boolean; cost: number } => {
      const children = index.children.get(p) ?? [];
      if (children.length === 0) return { ok: false, cost: 0 };
      let cost = Infinity;
      for (const c of children) {
        if (!memberSet.has(c) || (protectedBelow !== undefined && protectedBelow.get(c) === true)) {
          return { ok: false, cost: 0 };
        }
        cost = Math.min(cost, salience.get(c) ?? 0);
      }
      return { ok: true, cost };
    };

    const heap = new CandidateHeap();
    // Seed: every node whose full detail-child frontier is currently visible.
    const candidateSeen = new Set<NodeId>();
    for (const n of index.nodes) {
      const children = index.children.get(n) ?? [];
      if (children.length === 0 || memberSet.has(n)) continue;
      const e = eligible(n);
      if (e.ok) {
        heap.push(n, e.cost);
        candidateSeen.add(n);
      }
    }

    while (memberSet.size > budget.maxNodes) {
      const top = heap.pop();
      if (top === undefined) break; // coverage wins over budget
      const p = top.node;
      if (memberSet.has(p)) continue; // already rolled up as someone's child
      const e = eligible(p);
      if (!e.ok || e.cost !== top.cost) {
        // Stale (shouldn't happen — children of a node are exclusive to it),
        // but re-push a corrected entry if it is still collapsible.
        if (e.ok) heap.push(p, e.cost);
        continue;
      }
      const children = [...(index.children.get(p) ?? [])].sort(compareIds);
      for (const c of children) {
        memberSet.delete(c);
        trace.delete(c);
      }
      memberSet.add(p);
      const graph = index.graphOf.get(p)!;
      const depth = index.depth.get(p) ?? 0;
      trace.set(p, {
        node: p,
        graph,
        depth,
        reason: 'budget',
        coveredLeaves: index.subtreeLeaves.get(p) ?? 1,
      });
      collapsed.push({ node: p, replaced: children, losingSalience: top.cost });

      // The parent may now have a fully-visible frontier.
      const parent = index.parent.get(p);
      if (parent !== undefined && !candidateSeen.has(parent)) {
        const pe = eligible(parent);
        if (pe.ok) {
          heap.push(parent, pe.cost);
          candidateSeen.add(parent);
        }
      }
    }

    return { maxNodes: budget.maxNodes, collapsed, exceeded: memberSet.size > budget.maxNodes };
  }

  private frontier(
    memberSet: ReadonlySet<NodeId>,
    effective: ReadonlyMap<NodeId, OverrideKind>,
    focus: NodeId | undefined,
  ): { expandable: NodeId[]; collapsible: NodeId[] } {
    const index = this.index;
    const expandable: NodeId[] = [];
    for (const m of memberSet) {
      if (!isLeafNode(index, m)) expandable.push(m);
    }

    // A member is collapsible when its parent's whole child frontier is visible
    // and nothing under the parent is forced open (ADR-0012).
    const protectedSet = new Set<NodeId>();
    for (const [node, kind] of effective) {
      if (kind === 'pin' || kind === 'expand') protectedSet.add(node);
    }
    if (focus !== undefined && index.nodeOf.has(focus)) {
      let cur: NodeId | undefined = focus;
      while (cur !== undefined) {
        protectedSet.add(cur);
        cur = index.parent.get(cur);
      }
    }
    const protectedBelow =
      protectedSet.size > 0 ? this.reverseFold((n, childHas) => protectedSet.has(n) || childHas) : undefined;
    const parentRollsUp = (parent: NodeId): boolean => {
      const children = index.children.get(parent) ?? [];
      if (children.length === 0) return false;
      return children.every(
        (c) => memberSet.has(c) && (protectedBelow === undefined || protectedBelow.get(c) !== true),
      );
    };

    const collapsible: NodeId[] = [];
    for (const m of memberSet) {
      const parent = index.parent.get(m);
      if (parent !== undefined && parentRollsUp(parent)) collapsible.push(m);
    }

    expandable.sort(compareIds);
    collapsible.sort(compareIds);
    return { expandable, collapsible };
  }
}

/**
 * Convenience free function (ROADMAP §6 `resolveLod`): resolve one request
 * without holding a resolver. Prefer {@link LodResolver} when resolving many
 * requests over one snapshot (it precomputes the forest index once).
 */
export function resolveLod(
  space: GraphSpace,
  chain: LevelChain,
  policy: ZoomPolicy,
  req: LodRequest,
  options?: LodResolverOptions,
): LodResult {
  return new LodResolver(space, chain, policy, options).resolve(req);
}
