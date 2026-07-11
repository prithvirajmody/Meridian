import { describe, expect, it } from 'vitest';
import {
  isLabelEligible,
  LABEL_CLASS_CONNECTED,
  LABEL_CLASS_FORCED,
  LABEL_CLASS_ORDINARY,
  LABEL_CLASS_SUMMARY,
  labelTier,
  projectedNodeHeight,
} from '../src/index.js';

describe('ADR-0020 label tiers', () => {
  it.each([
    [-1, LABEL_CLASS_FORCED],
    [0, LABEL_CLASS_FORCED],
    [7.999, LABEL_CLASS_FORCED],
    [8, LABEL_CLASS_SUMMARY],
    [15.999, LABEL_CLASS_SUMMARY],
    [16, LABEL_CLASS_CONNECTED],
    [27.999, LABEL_CLASS_CONNECTED],
    [28, LABEL_CLASS_ORDINARY],
    [Number.NaN, LABEL_CLASS_FORCED],
  ])('maps projected height %s to tier %s', (height, expected) => {
    expect(labelTier(height)).toBe(expected);
  });

  it('projects world height using CSS-pixels-per-world-unit camera scale only', () => {
    expect(
      projectedNodeHeight(
        { x: 0, y: 0, width: 100, height: 12 },
        { center: { x: 999, y: -999 }, scale: 2 },
      ),
    ).toBe(24);
    expect(
      projectedNodeHeight(
        { x: 0, y: 0, width: 100, height: 0 },
        { center: { x: 0, y: 0 }, scale: 2 },
      ),
    ).toBe(0);
  });

  it('uses numeric class ordering for eligibility', () => {
    expect(isLabelEligible(LABEL_CLASS_SUMMARY, LABEL_CLASS_CONNECTED)).toBe(true);
    expect(isLabelEligible(LABEL_CLASS_ORDINARY, LABEL_CLASS_CONNECTED)).toBe(false);
  });
});
