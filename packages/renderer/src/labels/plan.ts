/**
 * ADR-0020 pure label pipeline: candidate selection (tier-gated), deterministic
 * ordering, an 8-CSS-px occupancy grid with 2-CSS-px padding, the 512 global cap
 * with hover/anchor priority, and the 64-live shaped-Unicode fallback cap. All
 * geometry is CSS-pixel and DPR-independent; no Pixi/DOM/canvas dependency.
 */
import {
  LABEL_CLASS_FORCED,
  labelTier,
  projectedNodeHeight,
  worldToScreen,
  type CameraState,
  type LabelClass,
  type NodeId,
  type RenderModel,
  type ViewportSize,
} from '@meridian/view-model';
import { labelRenderKind, type AtlasCoverage, type LabelRenderKind } from './render-kind.js';
import { truncateLabel } from './truncate.js';

/** Occupancy-grid cell size (ADR-0020). */
export const LABEL_CELL_SIZE_CSS_PX = 8;
/** Padding added to every label AABB before rasterizing into the grid. */
export const LABEL_CELL_PADDING_CSS_PX = 2;
/** Global live-label safety rail, including forced labels. */
export const LABEL_MAX_LIVE = 512;
/** Live shaped-Unicode `Text` fallback ceiling (ADR-0020 §fallback, ruling 5A). */
export const LABEL_FALLBACK_MAX_LIVE = 64;
/** Constant nominal text size of the screen-space overlay, in CSS pixels. */
export const LABEL_NOMINAL_SIZE_CSS_PX = 12;
/** Deterministic per-grapheme advance used only to size collision AABBs. */
export const LABEL_GLYPH_ADVANCE_CSS_PX = 7;
/** Collision AABB height at the nominal size, in CSS pixels. */
export const LABEL_LINE_HEIGHT_CSS_PX = 14;

export interface PlannedLabel {
  readonly nodeIndex: number;
  readonly nodeId: NodeId;
  /** Truncated, measurement-ready text. */
  readonly text: string;
  /** Screen-space center in CSS pixels (overlay is unscaled by the camera). */
  readonly screenX: number;
  readonly screenY: number;
  readonly labelClass: LabelClass;
  readonly renderKind: LabelRenderKind;
  /** Hover or selection-anchor promotion; may overlap and has eviction priority. */
  readonly forced: boolean;
  readonly isHover: boolean;
  /**
   * Draw opacity `(0,1]`. `1` outside transitions. During a transition frame
   * (ADR-0023) a label follows its node's alpha through the final-30% window:
   * text fades in only over the last 30% of its node's fade so mid-flight text
   * never pops.
   */
  readonly alpha: number;
}

/** ADR-0023 label fade window: node alpha `[0.7, 1] → [0, 1]`, else invisible. */
export function labelFadeAlpha(nodeAlpha: number): number {
  const value = (nodeAlpha - 0.7) / 0.3;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export interface LabelPlan {
  /** Drawn labels in acceptance order (forced/hover first). */
  readonly labels: readonly PlannedLabel[];
  readonly bitmapLabelCount: number;
  readonly fallbackLabelCount: number;
  readonly omittedLabelCount: number;
  /** Deduplicated overflow notices, e.g. `'fallback-cap-exceeded'`. */
  readonly diagnostics: readonly string[];
}

export interface LabelPlanOptions {
  readonly maxLive?: number;
  readonly fallbackMaxLive?: number;
}

export interface LabelPlanInput {
  readonly model: RenderModel;
  readonly camera: CameraState;
  readonly viewport: ViewportSize;
  /** Quadtree-visible node indices; only these are considered (ADR-0020). */
  readonly visibleNodeIndices: Iterable<number>;
  /** Transient hover promotion to the forced class, or `null`. */
  readonly hoverNodeIndex: number | null;
  /** MSDF atlas coverage used to route bitmap vs fallback. */
  readonly coverage: AtlasCoverage;
}

interface Candidate {
  readonly nodeIndex: number;
  readonly nodeId: NodeId;
  readonly text: string;
  readonly graphemeCount: number;
  readonly screenX: number;
  readonly screenY: number;
  readonly effectiveClass: LabelClass;
  readonly coveredLeaves: number;
  readonly degree: number;
  readonly forced: boolean;
  readonly isHover: boolean;
}

function compareNodeId(a: NodeId, b: NodeId): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** ADR-0020 ordering: class ↑, coveredLeaves ↓, inducedDegree ↓, NodeId ↑. */
function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    a.effectiveClass - b.effectiveClass ||
    b.coveredLeaves - a.coveredLeaves ||
    b.degree - a.degree ||
    compareNodeId(a.nodeId, b.nodeId)
  );
}

/** Forced order: hover first, then the selection anchor, then the shared tie-break. */
function compareForced(a: Candidate, b: Candidate): number {
  if (a.isHover !== b.isHover) return a.isHover ? -1 : 1;
  return compareCandidates(a, b);
}

function occupancyCells(candidate: Candidate): number[] {
  const halfWidth = (candidate.graphemeCount * LABEL_GLYPH_ADVANCE_CSS_PX) / 2;
  const halfHeight = LABEL_LINE_HEIGHT_CSS_PX / 2;
  const pad = LABEL_CELL_PADDING_CSS_PX;
  const minCol = Math.floor((candidate.screenX - halfWidth - pad) / LABEL_CELL_SIZE_CSS_PX);
  const maxCol = Math.floor((candidate.screenX + halfWidth + pad) / LABEL_CELL_SIZE_CSS_PX);
  const minRow = Math.floor((candidate.screenY - halfHeight - pad) / LABEL_CELL_SIZE_CSS_PX);
  const maxRow = Math.floor((candidate.screenY + halfHeight + pad) / LABEL_CELL_SIZE_CSS_PX);
  const cells: number[] = [];
  for (let row = minRow; row <= maxRow; row++) {
    for (let col = minCol; col <= maxCol; col++) {
      // Interleave into a single safe-integer key; columns/rows may be negative.
      cells.push(row * 0x4000_0000 + col);
    }
  }
  return cells;
}

function nodeCenterScreen(
  model: RenderModel,
  index: number,
  camera: CameraState,
  viewport: ViewportSize,
): { x: number; y: number } {
  const lane = index * 4;
  const world = {
    x: model.nodeRects[lane]! + model.nodeRects[lane + 2]! / 2,
    y: model.nodeRects[lane + 1]! + model.nodeRects[lane + 3]! / 2,
  };
  return worldToScreen(world, camera, viewport);
}

/** Produce the deterministic set of drawn labels for one frame. */
export function planLabels(input: LabelPlanInput, options: LabelPlanOptions = {}): LabelPlan {
  const { model, camera, viewport, hoverNodeIndex, coverage } = input;
  const maxLive = options.maxLive ?? LABEL_MAX_LIVE;
  const fallbackMaxLive = options.fallbackMaxLive ?? LABEL_FALLBACK_MAX_LIVE;

  const candidates: Candidate[] = [];
  for (const nodeIndex of input.visibleNodeIndices) {
    if (nodeIndex < 0 || nodeIndex >= model.nodeIds.length) continue;
    // Transition frames (ADR-0023): a node still outside its label fade
    // window contributes no label candidate at all — invisible text must not
    // claim occupancy cells or live-label slots.
    if (model.nodeAlphas !== undefined && labelFadeAlpha(model.nodeAlphas[nodeIndex] ?? 1) <= 0) {
      continue;
    }
    const lane = nodeIndex * 4;
    const worldHeight = model.nodeRects[lane + 3]!;
    const projected = projectedNodeHeight(
      { x: 0, y: 0, width: 0, height: worldHeight },
      camera,
    );
    const tier = labelTier(projected);
    const isHover = hoverNodeIndex === nodeIndex;
    const modelClass = model.labelClasses[nodeIndex] as LabelClass;
    const effectiveClass: LabelClass = isHover ? LABEL_CLASS_FORCED : modelClass;
    const forced = effectiveClass === LABEL_CLASS_FORCED;
    if (!forced && effectiveClass > tier) continue;

    const source = model.labelTable[model.labelRefs[nodeIndex]!] ?? '';
    const truncated = truncateLabel(source);
    const center = nodeCenterScreen(model, nodeIndex, camera, viewport);
    candidates.push({
      nodeIndex,
      nodeId: model.nodeIds[nodeIndex]!,
      text: truncated.text,
      graphemeCount: truncated.graphemeCount,
      screenX: center.x,
      screenY: center.y,
      effectiveClass,
      coveredLeaves: model.nodeCoveredLeaves[nodeIndex]!,
      degree: model.nodeDegrees[nodeIndex]!,
      forced,
      isHover,
    });
  }

  const forcedCandidates = candidates.filter((c) => c.forced).sort(compareForced);
  const normalCandidates = candidates.filter((c) => !c.forced).sort(compareCandidates);
  const ordered = [...forcedCandidates, ...normalCandidates];

  const occupied = new Set<number>();
  const accepted: Candidate[] = [];
  for (const candidate of ordered) {
    // The 512-label rail is global: hover/anchor labels have first claim on
    // the bounded slots, but they do not make the bound elastic. A hostile or
    // hand-built RenderModel may contain more class-0 entries than the pure
    // view-model builder normally emits, so enforce the invariant here too.
    if (accepted.length >= maxLive) continue;
    const cells = occupancyCells(candidate);
    if (candidate.forced) {
      accepted.push(candidate);
      for (const cell of cells) occupied.add(cell);
      continue;
    }
    if (cells.some((cell) => occupied.has(cell))) continue;
    accepted.push(candidate);
    for (const cell of cells) occupied.add(cell);
  }

  const diagnostics: string[] = [];
  const labels: PlannedLabel[] = [];
  let bitmapLabelCount = 0;
  let fallbackLabelCount = 0;
  for (const candidate of accepted) {
    const renderKind = labelRenderKind(candidate.text, coverage);
    if (renderKind === 'fallback' && fallbackLabelCount >= fallbackMaxLive) {
      if (!diagnostics.includes('fallback-cap-exceeded')) diagnostics.push('fallback-cap-exceeded');
      continue;
    }
    if (renderKind === 'fallback') fallbackLabelCount++;
    else bitmapLabelCount++;
    labels.push({
      nodeIndex: candidate.nodeIndex,
      nodeId: candidate.nodeId,
      text: candidate.text,
      screenX: candidate.screenX,
      screenY: candidate.screenY,
      labelClass: candidate.effectiveClass,
      renderKind,
      forced: candidate.forced,
      isHover: candidate.isHover,
      alpha:
        model.nodeAlphas === undefined
          ? 1
          : labelFadeAlpha(model.nodeAlphas[candidate.nodeIndex] ?? 1),
    });
  }

  return {
    labels,
    bitmapLabelCount,
    fallbackLabelCount,
    omittedLabelCount: candidates.length - labels.length,
    diagnostics,
  };
}
