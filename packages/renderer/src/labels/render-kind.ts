/**
 * ADR-0020 pure text-path routing. Runs AFTER tiering/culling/collision/cap to
 * split accepted labels into the MSDF `BitmapText` fast path and the bounded
 * shaped-Unicode `Text` fallback. No Pixi/DOM/canvas dependency.
 */
import { segmentGraphemes } from './truncate.js';

export type LabelRenderKind = 'bitmap' | 'fallback';

/** Code-point membership of the checked-in MSDF atlas. */
export interface AtlasCoverage {
  has(codePoint: number): boolean;
}

/** Inclusive `[start,end]` code-point ranges. */
export type CodePointRange = readonly [number, number];

/** Build coverage from sorted-or-unsorted inclusive ranges. */
export function coverageFromRanges(ranges: readonly CodePointRange[]): AtlasCoverage {
  const normalized = ranges
    .map(([start, end]) => [Math.min(start, end), Math.max(start, end)] as const)
    .sort((a, b) => a[0] - b[0]);
  return {
    has(codePoint: number): boolean {
      for (const [start, end] of normalized) {
        if (codePoint < start) return false;
        if (codePoint <= end) return true;
      }
      return false;
    },
  };
}

/** Build coverage from an explicit code-point set. */
export function coverageFromCodePoints(codePoints: Iterable<number>): AtlasCoverage {
  const set = new Set(codePoints);
  return { has: (codePoint: number): boolean => set.has(codePoint) };
}

/**
 * Scripts that need contextual shaping/reordering the MSDF path cannot perform.
 * Membership forces the browser-canvas fallback regardless of atlas coverage.
 */
function isShapingRequired(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) || // combining diacritical marks
    (codePoint >= 0x0590 && codePoint <= 0x05ff) || // Hebrew
    (codePoint >= 0x0600 && codePoint <= 0x08ff) || // Arabic, Syriac, Thaana, N'Ko…
    (codePoint >= 0x0900 && codePoint <= 0x0dff) || // Indic (Devanagari…Malayalam)
    (codePoint >= 0x0e00 && codePoint <= 0x0fff) || // Thai, Lao, Tibetan
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) || // combining marks extended
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) || // combining marks supplement
    codePoint === 0x200c || // ZWNJ
    codePoint === 0x200d || // ZWJ
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) || // combining marks for symbols
    (codePoint >= 0xfb1d && codePoint <= 0xfdff) || // Hebrew/Arabic presentation forms
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) || // variation selectors
    (codePoint >= 0xfe70 && codePoint <= 0xfeff) || // Arabic presentation forms-B
    codePoint >= 0x1f000 // supplementary symbols/emoji planes
  );
}

/**
 * Classify a (already truncated) label. Any grapheme cluster wider than one
 * code point, any shaping-required code point, or any code point outside the
 * atlas routes the whole label to the fallback path.
 */
export function labelRenderKind(text: string, coverage: AtlasCoverage): LabelRenderKind {
  for (const cluster of segmentGraphemes(text)) {
    const codePoints = [...cluster];
    if (codePoints.length > 1) return 'fallback';
    const codePoint = cluster.codePointAt(0);
    if (codePoint === undefined) continue;
    if (isShapingRequired(codePoint)) return 'fallback';
    if (!coverage.has(codePoint)) return 'fallback';
  }
  return 'bitmap';
}
