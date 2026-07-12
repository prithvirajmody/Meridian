/**
 * Scale ↔ z coupling (ADR-0025): the log-linear map, its exact inverse, the
 * overzoom-slack camera limits, and the world-bounds range derivation.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  assertValidScaleRange,
  cameraScaleLimits,
  deriveScaleRange,
  scaleForZ,
  zForScale,
  type ScaleRange,
} from '../src/coupling.js';
import { OVERZOOM_MAX } from '../src/constants.js';

const range: ScaleRange = { sMin: 2, sMax: 512 };

describe('scale ↔ z coupling (ADR-0025)', () => {
  it('maps the range ends to z = 0 (fit-all) and z = 1 (readable leaf)', () => {
    expect(zForScale(range.sMin, range)).toBeCloseTo(0, 12);
    expect(zForScale(range.sMax, range)).toBeCloseTo(1, 12);
    expect(scaleForZ(0, range)).toBeCloseTo(range.sMin, 12);
    expect(scaleForZ(1, range)).toBeCloseTo(range.sMax, 12);
  });

  it('is log-linear: z = 0.5 sits at the geometric mean of the range', () => {
    expect(scaleForZ(0.5, range)).toBeCloseTo(Math.sqrt(range.sMin * range.sMax), 9);
  });

  it('round-trips z → scale → z exactly (one source of truth)', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (z) => {
        expect(zForScale(scaleForZ(z, range), range)).toBeCloseTo(z, 10);
      }),
    );
  });

  it('clamps geometric overzoom to z ∈ [0,1] — scale past the range never moves z', () => {
    expect(zForScale(range.sMax * OVERZOOM_MAX, range)).toBe(1);
    expect(zForScale(range.sMin / OVERZOOM_MAX, range)).toBe(0);
  });

  it('a degenerate range maps everything to z = 1', () => {
    const deg: ScaleRange = { sMin: 5, sMax: 5 };
    expect(zForScale(1, deg)).toBe(1);
    expect(zForScale(100, deg)).toBe(1);
    expect(scaleForZ(0.3, deg)).toBe(5);
  });

  it('camera limits add OVERZOOM_MAX slack on both ends', () => {
    const limits = cameraScaleLimits(range);
    expect(limits.min).toBeCloseTo(range.sMin / OVERZOOM_MAX, 12);
    expect(limits.max).toBeCloseTo(range.sMax * OVERZOOM_MAX, 12);
  });

  it('rejects a malformed range (located throw)', () => {
    expect(() => assertValidScaleRange({ sMin: 0, sMax: 1 })).toThrow(RangeError);
    expect(() => assertValidScaleRange({ sMin: 10, sMax: 1 })).toThrow(RangeError);
  });
});

describe('deriveScaleRange (ADR-0025 world-bounds derivation)', () => {
  it('fits bounds into the viewport at s_min (with FRAME_MARGIN)', () => {
    const r = deriveScaleRange({ x: 0, y: 0, width: 1000, height: 1000 }, { width: 800, height: 600 });
    // s_min fits the padded bounds: viewport is the binding dimension.
    expect(r.sMin).toBeLessThanOrEqual(r.sMax);
    expect(r.sMin).toBeGreaterThan(0);
    // A leaf is readable at s_max, so s_max ≥ s_min.
    expect(r.sMax).toBeGreaterThanOrEqual(r.sMin);
  });

  it('degenerate bounds/viewport yield a safe unit range', () => {
    expect(deriveScaleRange({ x: 0, y: 0, width: 0, height: 0 }, { width: 800, height: 600 })).toEqual({
      sMin: 1,
      sMax: 1,
    });
  });
});
