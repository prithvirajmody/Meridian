import { describe, expect, it } from 'vitest';
import {
  computeNearestScrollTop,
  computeVirtualWindow,
  OUTLINE_OVERSCAN,
  OUTLINE_ROW_HEIGHT,
} from '../src/outline-virtual-list.js';

describe('computeVirtualWindow', () => {
  it('returns an empty window without inventing height or rows', () => {
    expect(computeVirtualWindow(0, 0, 320)).toEqual({
      startIndex: 0,
      endIndex: 0,
      offsetTop: 0,
      totalHeight: 0,
    });
    expect(computeVirtualWindow(10, 0, 0)).toEqual({
      startIndex: 0,
      endIndex: 0,
      offsetTop: 0,
      totalHeight: 320,
    });
  });

  it('clips top overscan and uses an exclusive end index', () => {
    expect(computeVirtualWindow(100, 0, 320)).toEqual({
      startIndex: 0,
      endIndex: 14,
      offsetTop: 0,
      totalHeight: 3_200,
    });
  });

  it('applies symmetric overscan in the middle', () => {
    expect(computeVirtualWindow(1_000, 3_200, 320)).toEqual({
      startIndex: 96,
      endIndex: 114,
      offsetTop: 3_072,
      totalHeight: 32_000,
    });
  });

  it('includes both fractional-edge rows and clips bottom overscan', () => {
    expect(computeVirtualWindow(100, 32.25, 64)).toEqual({
      startIndex: 0,
      endIndex: 8,
      offsetTop: 0,
      totalHeight: 3_200,
    });
    expect(computeVirtualWindow(100, 99_999, 320)).toEqual({
      startIndex: 86,
      endIndex: 100,
      offsetTop: 2_752,
      totalHeight: 3_200,
    });
  });

  it('renders all rows when the viewport is larger than the content', () => {
    expect(computeVirtualWindow(7, 900, 10_000)).toEqual({
      startIndex: 0,
      endIndex: 7,
      offsetTop: 0,
      totalHeight: 224,
    });
  });

  it('keeps a 100k-row model bounded by visible rows plus overscan', () => {
    const window = computeVirtualWindow(100_000, 1_234_567.5, 320);
    expect(window.endIndex - window.startIndex).toBeLessThanOrEqual(
      Math.ceil(320 / OUTLINE_ROW_HEIGHT) + 1 + OUTLINE_OVERSCAN * 2,
    );
    expect(window.totalHeight).toBe(3_200_000);
    expect(window.startIndex).toBeGreaterThan(38_000);
    expect(window.endIndex).toBeLessThan(39_000);
  });

  it('supports explicit sizing and rejects impossible geometry', () => {
    expect(computeVirtualWindow(20, 25, 50, 25, 2)).toEqual({
      startIndex: 0,
      endIndex: 5,
      offsetTop: 0,
      totalHeight: 500,
    });
    expect(() => computeVirtualWindow(-1, 0, 1)).toThrow('rowCount');
    expect(() => computeVirtualWindow(1, Number.NaN, 1)).toThrow('scrollTop');
    expect(() => computeVirtualWindow(1, 0, 1, 0)).toThrow('rowHeight');
    expect(() => computeVirtualWindow(1, 0, 1, 32, -1)).toThrow('overscan');
  });
});

describe('computeNearestScrollTop', () => {
  it('returns zero for an empty list or an oversized viewport', () => {
    expect(computeNearestScrollTop(0, 0, 500, 320)).toBe(0);
    expect(computeNearestScrollTop(4, 5, 200, 1_000)).toBe(0);
  });

  it('does not move a fully visible row', () => {
    expect(computeNearestScrollTop(5, 100, 128, 128)).toBe(128);
  });

  it('aligns only the nearest edge above or below the viewport', () => {
    expect(computeNearestScrollTop(2, 100, 100, 128)).toBe(64);
    expect(computeNearestScrollTop(9, 100, 100, 128)).toBe(192);
  });

  it('clamps current and requested positions at list boundaries', () => {
    expect(computeNearestScrollTop(0, 100, 50_000, 320)).toBe(0);
    expect(computeNearestScrollTop(99, 100, 0, 320)).toBe(2_880);
  });

  it('handles a fractional scroll position without rounding away visibility', () => {
    expect(computeNearestScrollTop(3, 100, 32.25, 64)).toBe(64);
    expect(computeNearestScrollTop(2, 100, 32.25, 64)).toBe(32.25);
  });

  it('validates a non-empty target index', () => {
    expect(() => computeNearestScrollTop(5, 5, 0, 32)).toThrow('rowIndex');
    expect(() => computeNearestScrollTop(-1, 5, 0, 32)).toThrow('rowIndex');
  });
});
