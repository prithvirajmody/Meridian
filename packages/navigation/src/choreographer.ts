/**
 * The `TransitionChoreographer` (ADR-0023): a **pure** planner that turns a
 * cut change into an inspectable `TransitionPlan` — enter/exit/move `NodeAnim`s
 * with spawn geometry, a mode (`choreographed` | `crossfade`), a duration, and
 * diagnostics that name any degrade trigger. Feel bugs become fixtures before a
 * single pixel moves (ROADMAP §9a).
 *
 * Geometry (ADR-0023):
 * - **enter** tweens from its source's `from` rect (its final rect mapped back
 *   into the parent rect's normalized coordinates) to its `to` rect, alpha 0→1;
 *   a sourceless enter fades in at its final rect.
 * - **exit** tweens from its `from` rect to its target's `to` rect (collapsing
 *   into the ancestor), alpha 1→0; a targetless exit fades out in place.
 * - **move** tweens rect→rect.
 *
 * Degrade-to-crossfade is a **plan-time, pure** decision (ADR-0023): the mode
 * flips to `crossfade` when the animated-node budget, the sourceless-majority,
 * or the stability floor trips — and the plan records which.
 *
 * Nothing here reads wall time (I6): the plan emits a `durationMs`, never
 * timestamps; the renderer-side player advances it on an injected clock.
 */
import {
  characteristicLength,
  STABILITY_EPSILON,
  stabilityScore,
  type Cut,
  type LayoutHints,
  type LayoutResult,
  type NodeId,
  type Rect,
} from '@meridian/view-model';
import {
  BASE_TRANSITION_MS,
  CROSSFADE_MS,
  MAX_ANIMATED_NODES,
  SOURCELESS_MAJORITY,
  STABILITY_DEGRADE_FLOOR,
} from './constants.js';
import { affineRectMap, boundingRect, rectCenter } from './geometry.js';
import type { EnterEntry, ExitEntry, RefinementMap } from './refinement.js';

/** `choreographed` — per-node tweens; `crossfade` — whole-frame fade, no
 * per-node geometry (ADR-0023). */
export type TransitionMode = 'choreographed' | 'crossfade';

/** One animated node: rect tween plus optional alpha fade (ADR-0023). */
export interface NodeAnim {
  readonly id: NodeId;
  readonly fromRect: Rect;
  readonly toRect: Rect;
  readonly fadeIn?: true;
  readonly fadeOut?: true;
}

/** Why a transition degraded (ADR-0023's three plan-time triggers). */
export type DegradeTrigger = 'animated-node-budget' | 'sourceless-majority' | 'low-stability';

/** A machine-readable plan note (ADR-0023: "feel bugs are inspectable data"). */
export interface PlanDiagnostic {
  readonly code: 'counts' | 'degrade-to-crossfade' | 'sourceless-enters' | 'targetless-exits';
  readonly message: string;
  /** Present on `degrade-to-crossfade`: the first trigger that fired. */
  readonly trigger?: DegradeTrigger;
  /** Present on `degrade-to-crossfade`: every trigger that fired. */
  readonly triggers?: readonly DegradeTrigger[];
  /** Named counts (enter/exit/move/displacedMoves/sourceless/targetless/…). */
  readonly data?: Readonly<Record<string, number>>;
}

/** A pure, inspectable transition plan (ADR-0023). */
export interface TransitionPlan {
  readonly mode: TransitionMode;
  readonly enter: readonly NodeAnim[];
  readonly exit: readonly NodeAnim[];
  readonly move: readonly NodeAnim[];
  /** ≤ `MAX_TRANSITION_MS`; `BASE_TRANSITION_MS` choreographed, `CROSSFADE_MS`
   * degraded. */
  readonly durationMs: number;
  readonly diagnostics: readonly PlanDiagnostic[];
}

/** A transition endpoint: a cut and its layout. `hints` is optional and only
 * refines `Λ`'s spacing fallback (ADR-0016); the two required fields match
 * ADR-0023's `plan(from: {cut, layout}, …)`. */
export interface TransitionFrame {
  readonly cut: Cut;
  readonly layout: LayoutResult;
  readonly hints?: LayoutHints;
}

const NO_HINTS: LayoutHints = {};

/** A degenerate point-rect at a rect's center — the spawn/merge fallback when a
 * source/target rect is unexpectedly missing from a layout. */
function pointRectAt(r: Rect): Rect {
  const c = rectCenter(r);
  return { x: c.x, y: c.y, width: 0, height: 0 };
}

/** Group entering nodes by their ancestor source; value is the bbox of the
 * group's incoming rects (the parent's refinement image `R_in`). */
function ancestorImageBboxes(
  enter: readonly EnterEntry[],
  toLayout: LayoutResult,
): Map<NodeId, Rect | undefined> {
  const byAncestor = new Map<NodeId, Rect[]>();
  for (const e of enter) {
    if (e.sourceKind !== 'ancestor' || e.source === undefined) continue;
    const rect = toLayout.positions.get(e.id);
    if (rect === undefined) continue;
    const list = byAncestor.get(e.source) ?? [];
    list.push(rect);
    byAncestor.set(e.source, list);
  }
  const out = new Map<NodeId, Rect | undefined>();
  for (const [ancestor, rects] of byAncestor) out.set(ancestor, boundingRect(rects));
  return out;
}

/** Group exiting nodes by their ancestor target; value is the bbox of the
 * group's outgoing rects (`R_from_group`). */
function ancestorFromBboxes(
  exit: readonly ExitEntry[],
  fromLayout: LayoutResult,
): Map<NodeId, Rect | undefined> {
  const byAncestor = new Map<NodeId, Rect[]>();
  for (const x of exit) {
    if (x.targetKind !== 'ancestor' || x.target === undefined) continue;
    const rect = fromLayout.positions.get(x.id);
    if (rect === undefined) continue;
    const list = byAncestor.get(x.target) ?? [];
    list.push(rect);
    byAncestor.set(x.target, list);
  }
  const out = new Map<NodeId, Rect | undefined>();
  for (const [ancestor, rects] of byAncestor) out.set(ancestor, boundingRect(rects));
  return out;
}

function buildEnterAnim(
  e: EnterEntry,
  fromLayout: LayoutResult,
  toLayout: LayoutResult,
  ancestorImage: Map<NodeId, Rect | undefined>,
): NodeAnim | undefined {
  const toRect = toLayout.positions.get(e.id);
  if (toRect === undefined) return undefined; // not laid out in `to` — nothing to animate
  const fadeIn = true as const;

  if (e.sourceKind === 'ancestor' && e.source !== undefined) {
    const rOut = fromLayout.positions.get(e.source); // parent's old rect
    const rIn = ancestorImage.get(e.source); // parent's refinement image
    if (rOut !== undefined && rIn !== undefined) {
      // Nest the child's final rect into the parent's old rect (ADR-0023).
      return { id: e.id, fromRect: affineRectMap(toRect, rIn, rOut), toRect, fadeIn };
    }
    if (rOut !== undefined) return { id: e.id, fromRect: pointRectAt(rOut), toRect, fadeIn };
    return { id: e.id, fromRect: toRect, toRect, fadeIn }; // fall back to fade-in-place
  }

  if (e.sourceKind === 'descendants' && e.sourceDescendants !== undefined) {
    const rects: Rect[] = [];
    for (const d of e.sourceDescendants) {
      const r = fromLayout.positions.get(d);
      if (r !== undefined) rects.push(r);
    }
    const spawn = boundingRect(rects);
    return { id: e.id, fromRect: spawn ?? toRect, toRect, fadeIn };
  }

  // Sourceless: fade in at the final rect (ADR-0023).
  return { id: e.id, fromRect: toRect, toRect, fadeIn };
}

function buildExitAnim(
  x: ExitEntry,
  fromLayout: LayoutResult,
  toLayout: LayoutResult,
  ancestorFrom: Map<NodeId, Rect | undefined>,
): NodeAnim | undefined {
  const fromRect = fromLayout.positions.get(x.id);
  if (fromRect === undefined) return undefined; // not laid out in `from`
  const fadeOut = true as const;

  if (x.targetKind === 'ancestor' && x.target !== undefined) {
    const rIn = toLayout.positions.get(x.target); // ancestor's new rect
    const rFromGroup = ancestorFrom.get(x.target); // bbox of exiting siblings
    if (rIn !== undefined && rFromGroup !== undefined) {
      // Collapse the exiting child into the ancestor's new rect (ADR-0023).
      return { id: x.id, fromRect, toRect: affineRectMap(fromRect, rFromGroup, rIn), fadeOut };
    }
    if (rIn !== undefined) return { id: x.id, fromRect, toRect: pointRectAt(rIn), fadeOut };
    return { id: x.id, fromRect, toRect: fromRect, fadeOut }; // fall back to fade-out-in-place
  }

  if (x.targetKind === 'descendants' && x.targetDescendants !== undefined) {
    const rects: Rect[] = [];
    for (const d of x.targetDescendants) {
      const r = toLayout.positions.get(d);
      if (r !== undefined) rects.push(r);
    }
    const merge = boundingRect(rects);
    return { id: x.id, fromRect, toRect: merge ?? fromRect, fadeOut };
  }

  // Targetless: fade out in place (ADR-0023).
  return { id: x.id, fromRect, toRect: fromRect, fadeOut };
}

/**
 * Plan a transition between two frames given their derived refinement
 * correspondence (ADR-0023). Pure and deterministic (I6): no wall-clock or
 * PRNG reads; identical inputs produce a deep-equal plan. Retargeting
 * mid-flight is the same call with the player's current interpolated
 * `{cut, layout}` as `from` — the choreographer holds no state.
 */
export function planTransition(
  from: TransitionFrame,
  to: TransitionFrame,
  refinement: RefinementMap,
): TransitionPlan {
  const fromHints = from.hints ?? NO_HINTS;
  const lambda = characteristicLength(from.layout, fromHints);
  const epsilonLambda = STABILITY_EPSILON * lambda;

  // Count displaced moves — a move counts as animated only when its center
  // moved more than ε·Λ (ADR-0016 terms; ADR-0023 degrade predicate).
  let displacedMoves = 0;
  for (const id of refinement.move) {
    const a = from.layout.positions.get(id);
    const b = to.layout.positions.get(id);
    if (a === undefined || b === undefined) continue;
    const ca = rectCenter(a);
    const cb = rectCenter(b);
    if (Math.hypot(ca.x - cb.x, ca.y - cb.y) > epsilonLambda) displacedMoves++;
  }

  const enterCount = refinement.enter.length;
  const exitCount = refinement.exit.length;
  const sourceless = refinement.enter.reduce((n, e) => n + (e.sourceKind === 'none' ? 1 : 0), 0);
  const targetless = refinement.exit.reduce((n, x) => n + (x.targetKind === 'none' ? 1 : 0), 0);
  const enterExit = enterCount + exitCount;
  const animatedCount = enterCount + exitCount + displacedMoves;
  const stability = stabilityScore(from.layout, to.layout, fromHints).stability;

  const triggers: DegradeTrigger[] = [];
  if (animatedCount > MAX_ANIMATED_NODES) triggers.push('animated-node-budget');
  if (enterExit > 0 && (sourceless + targetless) / enterExit > SOURCELESS_MAJORITY) {
    triggers.push('sourceless-majority');
  }
  if (stability < STABILITY_DEGRADE_FLOOR) triggers.push('low-stability');

  const counts: Record<string, number> = {
    enter: enterCount,
    exit: exitCount,
    move: refinement.move.length,
    displacedMoves,
    sourceless,
    targetless,
    animatedCount,
    stability,
    lambda,
  };
  const diagnostics: PlanDiagnostic[] = [
    { code: 'counts', message: 'transition set sizes', data: counts },
  ];
  if (sourceless > 0) {
    diagnostics.push({
      code: 'sourceless-enters',
      message: `${sourceless} entering node(s) have no source geometry`,
      data: { count: sourceless },
    });
  }
  if (targetless > 0) {
    diagnostics.push({
      code: 'targetless-exits',
      message: `${targetless} exiting node(s) have no target geometry`,
      data: { count: targetless },
    });
  }

  if (triggers.length > 0) {
    diagnostics.push({
      code: 'degrade-to-crossfade',
      message: `degraded to crossfade: ${triggers.join(', ')}`,
      trigger: triggers[0],
      triggers,
      data: counts,
    });
    return {
      mode: 'crossfade',
      enter: [],
      exit: [],
      move: [],
      durationMs: CROSSFADE_MS,
      diagnostics,
    };
  }

  const ancestorImage = ancestorImageBboxes(refinement.enter, to.layout);
  const ancestorFrom = ancestorFromBboxes(refinement.exit, from.layout);

  const enter: NodeAnim[] = [];
  for (const e of refinement.enter) {
    const anim = buildEnterAnim(e, from.layout, to.layout, ancestorImage);
    if (anim !== undefined) enter.push(anim);
  }
  const exit: NodeAnim[] = [];
  for (const x of refinement.exit) {
    const anim = buildExitAnim(x, from.layout, to.layout, ancestorFrom);
    if (anim !== undefined) exit.push(anim);
  }
  // Only *displaced* moves (> ε·Λ) are emitted: a "held" node reads as "stayed
  // put" (ADR-0016), so tweening it is a visual no-op the player can skip. This
  // makes `move.length === displacedMoves` and an identical-cut/identical-layout
  // transition an empty plan. (Reading flagged for ADR-0023 fold-back.)
  const move: NodeAnim[] = [];
  for (const id of refinement.move) {
    const fromRect = from.layout.positions.get(id);
    const toRect = to.layout.positions.get(id);
    if (fromRect === undefined || toRect === undefined) continue;
    const ca = rectCenter(fromRect);
    const cb = rectCenter(toRect);
    if (Math.hypot(ca.x - cb.x, ca.y - cb.y) <= epsilonLambda) continue;
    move.push({ id, fromRect, toRect });
  }

  return { mode: 'choreographed', enter, exit, move, durationMs: BASE_TRANSITION_MS, diagnostics };
}

/**
 * The choreographer as a stateless object (ADR-0023 names
 * `TransitionChoreographer.plan(...)`). It holds no fields — `plan` delegates to
 * the pure {@link planTransition} — so retarget-from-current-state is just
 * another call.
 */
export class TransitionChoreographer {
  plan(from: TransitionFrame, to: TransitionFrame, refinement: RefinementMap): TransitionPlan {
    return planTransition(from, to, refinement);
  }
}
