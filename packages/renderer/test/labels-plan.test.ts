import { describe, expect, it } from 'vitest';
import type { CameraState, ViewportSize } from '@meridian/view-model';
import { planLabels, type LabelPlanInput } from '../src/labels/plan.js';
import { coverageFromRanges, meridianAtlasCoverage } from '../src/labels/index.js';
import { modelOf, type RectTuple } from './support/model.js';

const VIEWPORT: ViewportSize = { width: 100_000, height: 100_000 };
const ASCII_COVERAGE = coverageFromRanges([
  [0x20, 0x7e],
  [0xa0, 0xff],
  [0x2026, 0x2026],
]);

function camera(scale: number): CameraState {
  return { center: { x: 0, y: 0 }, scale };
}

function nodeIndicesOf(plan: ReturnType<typeof planLabels>): number[] {
  return plan.labels.map((label) => label.nodeIndex).sort((a, b) => a - b);
}

function baseInput(overrides: Partial<LabelPlanInput> & Pick<LabelPlanInput, 'model'>): LabelPlanInput {
  return {
    camera: camera(1),
    viewport: VIEWPORT,
    visibleNodeIndices: overrides.model.nodeIds.map((_, index) => index),
    hoverNodeIndex: null,
    coverage: ASCII_COVERAGE,
    ...overrides,
  };
}

describe('ADR-0020 label plan — tier gating', () => {
  // Four spaced unit-height nodes, one per class. Projected height = scale.
  const rects: RectTuple[] = [0, 1, 2, 3].map((i) => [i * 4000, 0, 1, 1]);
  const model = modelOf(rects, [], { labelClasses: [0, 1, 2, 3] });

  it('shows only the forced class just below the summary threshold', () => {
    const plan = planLabels(baseInput({ model, camera: camera(7.99) }));
    expect(nodeIndicesOf(plan)).toEqual([0]);
  });

  it('adds summaries at exactly the 8px lower bound (inclusive)', () => {
    const plan = planLabels(baseInput({ model, camera: camera(8) }));
    expect(nodeIndicesOf(plan)).toEqual([0, 1]);
  });

  it('adds connected nodes at exactly 16px', () => {
    const plan = planLabels(baseInput({ model, camera: camera(16) }));
    expect(nodeIndicesOf(plan)).toEqual([0, 1, 2]);
  });

  it('adds all classes at exactly 28px', () => {
    const plan = planLabels(baseInput({ model, camera: camera(28) }));
    expect(nodeIndicesOf(plan)).toEqual([0, 1, 2, 3]);
  });

  it('promotes a hovered ordinary node below its tier', () => {
    const plan = planLabels(baseInput({ model, camera: camera(1), hoverNodeIndex: 3 }));
    // Node 0 is the class-0 anchor (always shown); the hovered ordinary node 3
    // is promoted above its tier and joins it.
    expect(nodeIndicesOf(plan)).toEqual([0, 3]);
    const hovered = plan.labels.find((label) => label.nodeIndex === 3);
    expect(hovered?.forced).toBe(true);
    expect(hovered?.isHover).toBe(true);
  });
});

describe('ADR-0020 label plan — ordering', () => {
  it('orders by class, coveredLeaves, degree, then NodeId', () => {
    const rects: RectTuple[] = Array.from({ length: 4 }, (_, i) => [i * 4000, 0, 100, 100]);
    const model = modelOf(rects, [], {
      labelClasses: [3, 3, 2, 3],
      coveredLeaves: [1, 5, 1, 5],
      degrees: [1, 1, 9, 9],
    });
    const plan = planLabels(baseInput({ model, camera: camera(1) }));
    // class 2 (index 2) first; then class 3 by coveredLeaves↓ then degree↓ then id↑.
    expect(plan.labels.map((label) => label.nodeIndex)).toEqual([2, 3, 1, 0]);
  });
});

describe('ADR-0020 label plan — collision grid', () => {
  it('rejects an overlapping normal label but keeps the higher-priority one', () => {
    const rects: RectTuple[] = [
      [0, 0, 100, 100],
      [1, 0, 100, 100], // essentially coincident on screen
    ];
    const model = modelOf(rects, [], { coveredLeaves: [9, 1] });
    const plan = planLabels(baseInput({ model, camera: camera(1) }));
    expect(nodeIndicesOf(plan)).toEqual([0]);
    expect(plan.omittedLabelCount).toBe(1);
  });

  it('lets forced labels overlap each other', () => {
    const rects: RectTuple[] = [
      [0, 0, 100, 100],
      [1, 0, 100, 100],
    ];
    const model = modelOf(rects, [], { labelClasses: [0, 0] });
    const plan = planLabels(baseInput({ model, camera: camera(1) }));
    expect(nodeIndicesOf(plan)).toEqual([0, 1]);
  });

  it('is deterministic for identical input', () => {
    const rects: RectTuple[] = Array.from({ length: 40 }, (_, i) => [i * 10, (i % 3) * 8, 100, 100]);
    const model = modelOf(rects);
    const a = planLabels(baseInput({ model, camera: camera(1) }));
    const b = planLabels(baseInput({ model, camera: camera(1) }));
    expect(a.labels).toEqual(b.labels);
  });
});

describe('ADR-0020 label plan — caps', () => {
  it('enforces the global live cap and drops the lowest-priority overflow', () => {
    const rects: RectTuple[] = Array.from({ length: 6 }, (_, i) => [i * 5000, 0, 100, 100]);
    const model = modelOf(rects);
    const plan = planLabels(baseInput({ model, camera: camera(1) }), { maxLive: 4 });
    expect(plan.labels).toHaveLength(4);
    expect(plan.omittedLabelCount).toBe(2);
  });

  it('keeps hover within a full cap by ordering forced first', () => {
    const rects: RectTuple[] = Array.from({ length: 6 }, (_, i) => [i * 5000, 0, 100, 100]);
    const model = modelOf(rects);
    const plan = planLabels(
      baseInput({ model, camera: camera(1), hoverNodeIndex: 5 }),
      { maxLive: 4 },
    );
    expect(plan.labels).toHaveLength(4);
    expect(plan.labels[0]?.nodeIndex).toBe(5);
    expect(plan.labels.some((label) => label.nodeIndex === 5)).toBe(true);
  });

  it('counts forced labels against the global cap', () => {
    const rects: RectTuple[] = Array.from({ length: 513 }, (_, i) => [i * 5000, 0, 100, 100]);
    const model = modelOf(rects, [], { labelClasses: new Array(513).fill(0) });
    const plan = planLabels(baseInput({ model }));

    expect(plan.labels).toHaveLength(512);
    expect(plan.labels.every((label) => label.forced)).toBe(true);
    expect(plan.omittedLabelCount).toBe(1);
  });

  it('caps the shaped-Unicode fallback and emits one deduplicated diagnostic', () => {
    const rects: RectTuple[] = Array.from({ length: 3 }, (_, i) => [i * 5000, 0, 100, 100]);
    const model = modelOf(rects, [], { labels: ['你好', '世界', '中文'] });
    const plan = planLabels(
      { ...baseInput({ model }), coverage: meridianAtlasCoverage() },
      { fallbackMaxLive: 1 },
    );
    expect(plan.fallbackLabelCount).toBe(1);
    expect(plan.bitmapLabelCount).toBe(0);
    expect(plan.omittedLabelCount).toBe(2);
    expect(plan.diagnostics).toEqual(['fallback-cap-exceeded']);
  });

  it('counts bitmap and fallback labels separately', () => {
    const rects: RectTuple[] = Array.from({ length: 4 }, (_, i) => [i * 5000, 0, 100, 100]);
    const model = modelOf(rects, [], { labels: ['alpha', '你好', 'beta', '世界'] });
    const plan = planLabels({ ...baseInput({ model }), coverage: meridianAtlasCoverage() });
    expect(plan.bitmapLabelCount).toBe(2);
    expect(plan.fallbackLabelCount).toBe(2);
    expect(plan.omittedLabelCount).toBe(0);
  });
});
