/**
 * The Studio-side transition animator (ADR-0023) — the **pure** half of the
 * player. Everything here is a deterministic value transform: prepare a
 * transition once (`prepareTransition`), then sample it at any eased progress
 * (`sampleTransitionModel`, `sampleCameraPath`). No wall clock, no DOM, no
 * renderer state — the imperative driver (`studio-navigator.ts`) advances the
 * eased progress on an *injected* clock, which is what makes mid-transition
 * screenshot baselines and unit tests deterministic (ADR-0023 "time is
 * injected").
 *
 * Geometry contract (ADR-0023): enter nodes tween spawn→final with alpha 0→1;
 * exit nodes tween from→merge with alpha 1→0; displaced moves tween rect→rect;
 * a crossfade blends the whole outgoing frame into the incoming frame. The
 * camera path holds the ADR-0024 anchor throughout the flight by re-solving
 * the closed-form center at every sample.
 */
import { solveCameraCenter, type NodeAnim, type TransitionPlan } from '@meridian/navigation';
import {
  worldToScreen,
  type CameraState,
  type NodeId,
  type Point,
  type Rect,
  type RenderModel,
  type ViewportSize,
} from '@meridian/view-model';

// ------------------------------------------------------------------- easing

/** The one shared easing (ADR-0023 `EASING = easeInOutCubic`) — rects, alpha,
 * and the camera path all sample this same curve. */
export function easeInOutCubic(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Scale interpolates in log space so zoom speed feels constant (the same
 * log-linear space the ADR-0025 coupling lives in). */
export function logLerp(a: number, b: number, t: number): number {
  return Math.exp(lerp(Math.log(a), Math.log(b), t));
}

// -------------------------------------------------------------- camera path

/** The anchored camera flight for one transition (ADR-0024). */
export interface CameraPath {
  readonly from: CameraState;
  readonly to: CameraState;
  /** Present for anchored continuous zoom; absent for drill/fly-to/mutation
   * flights, which frame their target instead (ADR-0024 fallbacks). */
  readonly anchor?: {
    readonly screen: Point;
    readonly worldOut: Point;
    readonly worldIn: Point;
  };
}

/**
 * Sample the camera at eased progress `e ∈ [0,1]`. With an anchor, the center
 * is **re-solved** each sample so the interpolated anchor world point stays on
 * the anchored screen point for the whole flight (ADR-0024 "holds throughout
 * the flight, not just at the ends"); the anchor rule never alters scale.
 */
export function sampleCameraPath(path: CameraPath, viewport: ViewportSize, e: number): CameraState {
  const scale = logLerp(path.from.scale, path.to.scale, e);
  if (path.anchor !== undefined) {
    const world = {
      x: lerp(path.anchor.worldOut.x, path.anchor.worldIn.x, e),
      y: lerp(path.anchor.worldOut.y, path.anchor.worldIn.y, e),
    };
    return { center: solveCameraCenter(world, path.anchor.screen, viewport, scale), scale };
  }
  return {
    center: {
      x: lerp(path.from.center.x, path.to.center.x, e),
      y: lerp(path.from.center.y, path.to.center.y, e),
    },
    scale,
  };
}

/** Measured anchor drift at eased progress `e` (ADR-0024): the distance in CSS
 * px between the anchored screen point and where the interpolated anchor world
 * point actually lands under `camera`. The <8px roadmap gate consumes this. */
export function anchorDriftPx(
  path: CameraPath,
  viewport: ViewportSize,
  e: number,
  camera: CameraState,
): number {
  if (path.anchor === undefined) return 0;
  const world = {
    x: lerp(path.anchor.worldOut.x, path.anchor.worldIn.x, e),
    y: lerp(path.anchor.worldOut.y, path.anchor.worldIn.y, e),
  };
  const screen = worldToScreen(world, camera, viewport);
  return Math.hypot(screen.x - path.anchor.screen.x, screen.y - path.anchor.screen.y);
}

// ------------------------------------------------------- prepared transition

interface IndexAnim {
  readonly nodeIndex: number;
  readonly fromRect: Rect;
  readonly toRect: Rect;
  /** `1` fade-in (enter), `0` hold opaque (move). */
  readonly fadeIn: boolean;
}

/** An outgoing-model node appended after the incoming model's nodes. */
interface ExtraNode {
  readonly id: NodeId;
  readonly fromRect: Rect;
  readonly toRect: Rect;
  /** Base opacity carried over from the outgoing model (itself possibly a
   * transition frame, when a retarget snapshotted mid-flight). */
  readonly baseAlpha: number;
  readonly colorId: number;
  readonly flags: number;
  readonly coveredLeaves: number;
  readonly degree: number;
  readonly labelRef: number;
  readonly labelClass: number;
}

export interface PreparedTransition {
  readonly mode: 'choreographed' | 'crossfade';
  readonly toModel: RenderModel;
  /** Union identity: `toModel.nodeIds` then the appended outgoing nodes. */
  readonly nodeIds: readonly NodeId[];
  /** Tweened incoming-model lanes (enter + displaced moves) by node index. */
  readonly anims: readonly IndexAnim[];
  /** Outgoing nodes drawn on top of the incoming set (exits / crossfade). */
  readonly extras: readonly ExtraNode[];
  /** Per-to-node base alpha (crossfade fades the whole incoming frame in). */
  readonly fadeInAllToNodes: boolean;
  // Merged static lanes (color/label tables may be unions of both models).
  readonly nodeColorKeys: readonly string[];
  readonly nodeColorIds: Uint16Array;
  readonly nodeFlags: Uint8Array;
  readonly nodeCoveredLeaves: Float64Array;
  readonly nodeDegrees: Uint32Array;
  readonly labelTable: readonly string[];
  readonly labelRefs: Uint32Array;
  readonly labelClasses: Uint8Array;
  /** Template world rects: final (`to`) rects then extras' from-rects. */
  readonly templateRects: Float64Array;
  readonly bounds: Rect;
  /** Unique per prepared transition; sampled revisions derive from it. */
  readonly key: string;
}

function mergeTables(
  toTable: readonly string[],
  extraValues: readonly string[],
): { table: readonly string[]; changed: boolean } {
  const missing = extraValues.filter((value) => !toTable.includes(value));
  if (missing.length === 0) return { table: toTable, changed: false };
  return { table: [...new Set([...toTable, ...missing])].sort(), changed: true };
}

function rectAt(lanes: Float64Array, index: number): Rect {
  const lane = index * 4;
  return {
    x: lanes[lane]!,
    y: lanes[lane + 1]!,
    width: lanes[lane + 2]!,
    height: lanes[lane + 3]!,
  };
}

function unionBounds(a: Rect, b: Rect): Rect {
  if (b.width === 0 && b.height === 0 && b.x === 0 && b.y === 0) return a;
  const minX = Math.min(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxX = Math.max(a.x + a.width, b.x + b.width);
  const maxY = Math.max(a.y + a.height, b.y + b.height);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

let preparedSequence = 0;

/**
 * Prepare a transition between two settled/sampled `RenderModel`s under a pure
 * `TransitionPlan` (ADR-0023). Choreographed mode animates exactly the plan's
 * enter/exit/move sets; crossfade mode blends the entire outgoing model into
 * the incoming one. Pure aside from a monotonic key counter (identity only —
 * no geometry reads it).
 */
export function prepareTransition(
  fromModel: RenderModel,
  toModel: RenderModel,
  plan: TransitionPlan,
): PreparedTransition {
  const toIndex = new Map<NodeId, number>();
  toModel.nodeIds.forEach((id, index) => toIndex.set(id, index));
  const fromIndex = new Map<NodeId, number>();
  fromModel.nodeIds.forEach((id, index) => fromIndex.set(id, index));

  const anims: IndexAnim[] = [];
  const exitAnimById = new Map<NodeId, NodeAnim>();
  if (plan.mode === 'choreographed') {
    for (const anim of plan.enter) {
      const nodeIndex = toIndex.get(anim.id);
      if (nodeIndex === undefined) continue;
      anims.push({ nodeIndex, fromRect: anim.fromRect, toRect: anim.toRect, fadeIn: true });
    }
    for (const anim of plan.move) {
      const nodeIndex = toIndex.get(anim.id);
      if (nodeIndex === undefined) continue;
      anims.push({ nodeIndex, fromRect: anim.fromRect, toRect: anim.toRect, fadeIn: false });
    }
    for (const anim of plan.exit) exitAnimById.set(anim.id, anim);
  }

  // Outgoing nodes to append: the plan's exits (choreographed) or every
  // outgoing node not re-used by the incoming cut (crossfade).
  const extraSources: { readonly id: NodeId; readonly fromIdx: number; readonly anim?: NodeAnim }[] = [];
  if (plan.mode === 'choreographed') {
    for (const [id, anim] of exitAnimById) {
      const fromIdx = fromIndex.get(id);
      if (fromIdx !== undefined) extraSources.push({ id, fromIdx, anim });
    }
  } else {
    fromModel.nodeIds.forEach((id, fromIdx) => {
      extraSources.push({ id, fromIdx });
    });
  }

  const colorMerge = mergeTables(
    toModel.nodeColorKeys,
    extraSources.map(({ fromIdx }) => fromModel.nodeColorKeys[fromModel.nodeColorIds[fromIdx]!] ?? ''),
  );
  const labelMerge = mergeTables(
    toModel.labelTable,
    extraSources.map(({ fromIdx }) => fromModel.labelTable[fromModel.labelRefs[fromIdx]!] ?? ''),
  );
  const colorLookup = new Map<string, number>();
  colorMerge.table.forEach((value, index) => colorLookup.set(value, index));
  const labelLookup = new Map<string, number>();
  labelMerge.table.forEach((value, index) => labelLookup.set(value, index));

  const extras: ExtraNode[] = extraSources.map(({ id, fromIdx, anim }) => {
    const fromRect = anim?.fromRect ?? rectAt(fromModel.nodeRects, fromIdx);
    const toRect = anim?.toRect ?? fromRect;
    return {
      id,
      fromRect,
      toRect,
      baseAlpha: fromModel.nodeAlphas?.[fromIdx] ?? 1,
      colorId: colorLookup.get(fromModel.nodeColorKeys[fromModel.nodeColorIds[fromIdx]!] ?? '') ?? 0,
      flags: fromModel.nodeFlags[fromIdx] ?? 0,
      coveredLeaves: fromModel.nodeCoveredLeaves[fromIdx] ?? 1,
      degree: fromModel.nodeDegrees[fromIdx] ?? 0,
      labelRef: labelLookup.get(fromModel.labelTable[fromModel.labelRefs[fromIdx]!] ?? '') ?? 0,
      labelClass: fromModel.labelClasses[fromIdx] ?? 0,
    };
  });

  const toCount = toModel.nodeIds.length;
  const total = toCount + extras.length;
  const nodeIds: NodeId[] = [...toModel.nodeIds, ...extras.map((extra) => extra.id)];

  const nodeColorIds = new Uint16Array(total);
  const nodeFlags = new Uint8Array(total);
  const nodeCoveredLeaves = new Float64Array(total);
  const nodeDegrees = new Uint32Array(total);
  const labelRefs = new Uint32Array(total);
  const labelClasses = new Uint8Array(total);
  const templateRects = new Float64Array(total * 4);

  for (let i = 0; i < toCount; i++) {
    nodeColorIds[i] = colorMerge.changed
      ? (colorLookup.get(toModel.nodeColorKeys[toModel.nodeColorIds[i]!] ?? '') ?? 0)
      : toModel.nodeColorIds[i]!;
    labelRefs[i] = labelMerge.changed
      ? (labelLookup.get(toModel.labelTable[toModel.labelRefs[i]!] ?? '') ?? 0)
      : toModel.labelRefs[i]!;
    nodeFlags[i] = toModel.nodeFlags[i]!;
    nodeCoveredLeaves[i] = toModel.nodeCoveredLeaves[i]!;
    nodeDegrees[i] = toModel.nodeDegrees[i]!;
    labelClasses[i] = toModel.labelClasses[i]!;
    templateRects.set(toModel.nodeRects.subarray(i * 4, i * 4 + 4), i * 4);
  }
  extras.forEach((extra, offset) => {
    const i = toCount + offset;
    nodeColorIds[i] = extra.colorId;
    nodeFlags[i] = extra.flags;
    nodeCoveredLeaves[i] = extra.coveredLeaves;
    nodeDegrees[i] = extra.degree;
    labelRefs[i] = extra.labelRef;
    labelClasses[i] = extra.labelClass;
    templateRects[i * 4] = extra.fromRect.x;
    templateRects[i * 4 + 1] = extra.fromRect.y;
    templateRects[i * 4 + 2] = extra.fromRect.width;
    templateRects[i * 4 + 3] = extra.fromRect.height;
  });

  return {
    mode: plan.mode,
    toModel,
    nodeIds,
    anims,
    extras,
    fadeInAllToNodes: plan.mode === 'crossfade',
    nodeColorKeys: colorMerge.table,
    nodeColorIds,
    nodeFlags,
    nodeCoveredLeaves,
    nodeDegrees,
    labelTable: labelMerge.table,
    labelRefs,
    labelClasses,
    templateRects,
    bounds: unionBounds(toModel.bounds, fromModel.bounds),
    key: `${fromModel.revision}>${toModel.revision}#${++preparedSequence}`,
  };
}

// ------------------------------------------------------------------ sampling

function lerpRectInto(target: Float64Array, lane: number, a: Rect, b: Rect, e: number): void {
  target[lane] = lerp(a.x, b.x, e);
  target[lane + 1] = lerp(a.y, b.y, e);
  target[lane + 2] = lerp(a.width, b.width, e);
  target[lane + 3] = lerp(a.height, b.height, e);
}

/**
 * Sample one transition frame at eased progress `e ∈ [0,1]` as a transient
 * `RenderModel` carrying alpha lanes. Deterministic: the same prepared
 * transition and `e` produce lane-identical output.
 */
export function sampleTransitionModel(prepared: PreparedTransition, e: number): RenderModel {
  const toModel = prepared.toModel;
  const toCount = toModel.nodeIds.length;
  const total = prepared.nodeIds.length;

  const nodeRects = prepared.templateRects.slice();
  const nodeAlphas = new Float32Array(total).fill(prepared.fadeInAllToNodes ? e : 1, 0, toCount);
  for (const anim of prepared.anims) {
    lerpRectInto(nodeRects, anim.nodeIndex * 4, anim.fromRect, anim.toRect, e);
    if (anim.fadeIn) nodeAlphas[anim.nodeIndex] = e;
  }
  prepared.extras.forEach((extra, offset) => {
    const index = toCount + offset;
    lerpRectInto(nodeRects, index * 4, extra.fromRect, extra.toRect, e);
    nodeAlphas[index] = extra.baseAlpha * (1 - e);
  });

  // Incoming-cut edges fade in with progress; routes are target-layout truth,
  // so keeping them faint while nodes move avoids stale-route artifacts.
  const edgeAlphas = new Float32Array(toModel.edgeKeys.length).fill(e);

  return {
    revision: `${toModel.revision}~${prepared.key}@${Math.round(e * 1_000_000)}`,
    bounds: prepared.bounds,
    nodeIds: prepared.nodeIds,
    nodeRects,
    nodeColorKeys: prepared.nodeColorKeys,
    nodeColorIds: prepared.nodeColorIds,
    nodeFlags: prepared.nodeFlags,
    nodeCoveredLeaves: prepared.nodeCoveredLeaves,
    nodeDegrees: prepared.nodeDegrees,
    labelTable: prepared.labelTable,
    labelRefs: prepared.labelRefs,
    labelClasses: prepared.labelClasses,
    nodeAlphas,
    edgeAlphas,
    edgeKeys: toModel.edgeKeys,
    edgeIndices: toModel.edgeIndices,
    edgeColorKeys: toModel.edgeColorKeys,
    edgeColorIds: toModel.edgeColorIds,
    edgeWeights: toModel.edgeWeights,
    edgeMultiplicities: toModel.edgeMultiplicities,
    edgeFlags: toModel.edgeFlags,
    edgeRouteOffsets: toModel.edgeRouteOffsets,
    edgeRoutePoints: toModel.edgeRoutePoints,
    diagnostics: toModel.diagnostics,
  };
}

/**
 * Snapshot the mid-flight state as retarget geometry (ADR-0023 "replans from
 * the current interpolated state"): every node still visible (alpha > 0) with
 * its current interpolated rect. The navigator wraps this into the
 * `{cut, layout}`-shaped from-state of the next plan.
 */
export function snapshotFlightLayout(
  prepared: PreparedTransition,
  e: number,
): { readonly members: readonly NodeId[]; readonly positions: ReadonlyMap<NodeId, Rect> } {
  const sampled = sampleTransitionModel(prepared, e);
  const members: NodeId[] = [];
  const positions = new Map<NodeId, Rect>();
  sampled.nodeIds.forEach((id, index) => {
    const alpha = sampled.nodeAlphas?.[index] ?? 1;
    if (alpha <= 0) return;
    if (positions.has(id)) return; // crossfade unions may repeat an id
    members.push(id);
    positions.set(id, rectAt(sampled.nodeRects, index));
  });
  return { members, positions };
}

// -------------------------------------------------------------- runtime guard

/** ADR-0023 runtime guard: 3 consecutive frames over 22ms mid-flight abandon
 * per-node tweens and finish as a ≤100ms fade. */
export const GUARD_FRAME_BUDGET_MS = 22;
export const GUARD_TRIP_FRAMES = 3;
export const GUARD_FINISH_FADE_MS = 100;

export interface GuardState {
  readonly consecutiveSlow: number;
  readonly tripped: boolean;
}

export const GUARD_INITIAL: GuardState = { consecutiveSlow: 0, tripped: false };

/** Advance the guard with one observed frame time (pure). */
export function guardStep(state: GuardState, frameTimeMs: number): GuardState {
  if (state.tripped) return state;
  const consecutiveSlow = frameTimeMs > GUARD_FRAME_BUDGET_MS ? state.consecutiveSlow + 1 : 0;
  return { consecutiveSlow, tripped: consecutiveSlow >= GUARD_TRIP_FRAMES };
}
