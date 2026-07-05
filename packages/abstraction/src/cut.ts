/**
 * Cuts (ARCHITECTURE.md §5.1; roadmap Phase 3 §7; ADR-0012). A `Cut` is the
 * visible antichain of a cut through the containment forest at a base level
 * `b`: for every root→leaf path, the node at depth `b`, or the leaf itself
 * when the path bottoms out first (ragged hierarchies, §5.6). This is the
 * covering antichain of ADR-0012's "default cut", and it satisfies **I5 —
 * cut coverage**: every leaf is covered exactly once.
 *
 * Phase 3B builds only this default cut. Per-node overrides (pin/expand/
 * collapse), the node budget, hysteresis, and induced edges are ADR-0012/
 * 0013/0014 material and land in Phases 3C/3D — deliberately not here.
 *
 * The `Cut` carries a covering proof; `verifyCoverage` re-derives I5 by an
 * independent method (root→leaf paths vs. the builder's subtree counts), so
 * the property suite is not checking the builder against itself.
 */
import {
  detailGraphOf,
  type GraphId,
  type GraphSpace,
  type NodeId,
  type SemanticGraph,
} from '@meridian/graph-core';
import { collectLeafPaths, countSubtreeLeaves, forestRootGraphs, totalLeaves } from './forest.js';
import type { LevelChain } from './level-chain.js';

/** Why a node is in the cut — the fixed ADR-0012 vocabulary, extended with
 * `budget` (ADR-0014). `buildCut` (the 3B default cut) emits only the `level`
 * and `leaf` subset; the resolver (3D) uses the full set:
 * - `level` — emitted because its depth is the base level `b`.
 * - `leaf` — emitted because it cannot be descended (a leaf, or ragged path).
 * - `pin` — emitted because it is pinned (held at its own granularity).
 * - `collapse` — emitted because it is collapsed (held above its level).
 * - `expand-parent` — emitted because an ancestor was expanded down to it
 *   (it sits below `b`).
 * - `cold` — emitted because its detail is unhydrated (reserved; P11 — no cold
 *   state exists in P3, where empty detail reads as `leaf`).
 * - `budget` — emitted because budget degradation rolled a frontier up to it
 *   (ADR-0014). */
export type CutReason = 'level' | 'leaf' | 'pin' | 'collapse' | 'expand-parent' | 'cold' | 'budget';

/** One member of the cut with its inclusion reason and the leaf count of the
 * subtree it stands in for (its summary weight; ADR-0012's dependency set). */
export interface CutMember {
  readonly node: NodeId;
  readonly graph: GraphId;
  readonly depth: number;
  readonly reason: CutReason;
  readonly coveredLeaves: number;
}

/** The covering proof attached to every cut (I5). Built from subtree leaf
 * counts, independent of `verifyCoverage`'s path-based recomputation. */
export interface CoverageProof {
  /** Total leaves in the forest. */
  readonly leaves: number;
  /** Σ of members' `coveredLeaves`. Equals `leaves` iff the cut covers. */
  readonly coveredLeaves: number;
  /** True iff every leaf is covered exactly once (I5). */
  readonly covers: boolean;
}

/** The visible antichain at a base level, plus its trace and covering proof. */
export interface Cut {
  /** The requested base level `b` (a containment depth). */
  readonly level: number;
  /** Visible node ids, sorted ascending (deterministic, I6). */
  readonly members: readonly NodeId[];
  /** Per-node inclusion reason + summary weight (ADR-0012 trace, 3B subset). */
  readonly trace: ReadonlyMap<NodeId, CutMember>;
  readonly coverage: CoverageProof;
}

function compareIds(a: NodeId, b: NodeId): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Build the default cut at base level `level` (a containment depth ≥ 0).
 * Descent stops — emitting the node — when it reaches `level`, or earlier if
 * the path bottoms out at a leaf; otherwise it descends into detail. A level
 * past the forest's depth yields all leaves (asking for more detail than
 * exists). Pure and deterministic (I6). The `chain` is accepted for API
 * symmetry and future level-name resolution; the mapping is depth-based
 * (ADR-0012), so the cut geometry does not depend on the names.
 */
export function buildCut(space: GraphSpace, _chain: LevelChain, level: number): Cut {
  if (!Number.isInteger(level) || level < 0) {
    throw new RangeError(`abstraction: cut level must be a non-negative integer, got ${level}`);
  }
  const trace = new Map<NodeId, CutMember>();

  const emit = (graph: SemanticGraph, nodeId: NodeId, depth: number, reason: CutReason): void => {
    trace.set(nodeId, {
      node: nodeId,
      graph: graph.id,
      depth,
      reason,
      coveredLeaves: countSubtreeLeaves(space, graph, nodeId),
    });
  };

  const visit = (graph: SemanticGraph, depth: number): void => {
    for (const node of graph.nodes.values()) {
      const detail = detailGraphOf(space, node);
      const leaf = detail === undefined || detail.nodes.size === 0;
      if (depth === level) {
        emit(graph, node.id, depth, 'level');
      } else if (leaf) {
        // Path bottoms out before the base level (ragged hierarchy, §5.6).
        emit(graph, node.id, depth, 'leaf');
      } else {
        visit(detail, depth + 1);
      }
    }
  };

  for (const graph of forestRootGraphs(space)) visit(graph, 0);

  const members = [...trace.keys()].sort(compareIds);
  const leaves = totalLeaves(space);
  let coveredLeaves = 0;
  for (const member of trace.values()) coveredLeaves += member.coveredLeaves;

  return {
    level,
    members,
    trace,
    coverage: { leaves, coveredLeaves, covers: coveredLeaves === leaves },
  };
}

/** The result of independently checking I5 for a cut. */
export interface CoverageResult {
  readonly ok: boolean;
  readonly totalLeaves: number;
  /** Leaves whose covering node is not in the cut (a coverage hole). */
  readonly uncovered: readonly NodeId[];
  /** Cut members covering no leaf (redundant — breaks the antichain
   * minimality the resolver relies on). */
  readonly spurious: readonly NodeId[];
}

/**
 * Re-derive I5 for a cut by an independent method: every forest leaf's unique
 * covering node (its ancestor at `min(level, leafDepth)`) must be a cut
 * member, and no member may be spurious (cover zero leaves). Computed via
 * root→leaf paths — not the subtree counts `buildCut` uses — so the property
 * suite tests the invariant, not the builder against itself.
 */
export function verifyCoverage(space: GraphSpace, cut: Cut): CoverageResult {
  const memberSet = new Set(cut.members);
  const hits = new Map<NodeId, number>();
  const uncovered: NodeId[] = [];
  const paths = collectLeafPaths(space);

  for (const path of paths) {
    // A leaf has exactly one covering node per level (its ancestor at that
    // depth, or itself when the level is deeper than the leaf) — so "covered
    // exactly once" reduces to "that covering node is a member".
    const covering = path.ancestors[Math.min(cut.level, path.depth)]!;
    if (memberSet.has(covering)) hits.set(covering, (hits.get(covering) ?? 0) + 1);
    else uncovered.push(path.leaf);
  }

  const spurious = cut.members.filter((m) => !hits.has(m));
  return {
    ok: uncovered.length === 0 && spurious.length === 0,
    totalLeaves: paths.length,
    uncovered,
    spurious,
  };
}
