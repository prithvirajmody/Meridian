/**
 * ADR-0020 grapheme-cluster truncation. Pure and DPR-independent: no Pixi, DOM,
 * or canvas dependency, so combining-mark/ZWJ behavior is unit-testable headless.
 */

/** Split into extended grapheme clusters (Intl.Segmenter) with a code-point fallback. */
export function segmentGraphemes(text: string): string[] {
  const segmenter = (
    Intl as { Segmenter?: new (locales?: undefined, options?: { granularity: string }) => {
      segment(input: string): Iterable<{ segment: string }>;
    } }
  ).Segmenter;
  if (typeof segmenter === 'function') {
    const instance = new segmenter(undefined, { granularity: 'grapheme' });
    const clusters: string[] = [];
    for (const { segment } of instance.segment(text)) clusters.push(segment);
    return clusters;
  }
  // Code-point fallback: never splits a surrogate pair, but does split combining
  // sequences. Acceptable degradation where Intl.Segmenter is unavailable.
  return [...text];
}

/** Max grapheme clusters (including a trailing ellipsis) drawn per label. */
export const LABEL_MAX_GRAPHEMES = 48;
export const LABEL_ELLIPSIS = '…';

export interface TruncatedLabel {
  /** The label as it should be measured and drawn. */
  readonly text: string;
  /** True when the source exceeded {@link LABEL_MAX_GRAPHEMES}. */
  readonly truncated: boolean;
  /** Grapheme-cluster count of {@link text} (never above the cap). */
  readonly graphemeCount: number;
}

/**
 * Truncate to at most {@link LABEL_MAX_GRAPHEMES} clusters. When truncation
 * occurs the final cluster is the ellipsis, so the drawn count stays at the cap.
 */
export function truncateLabel(text: string, max = LABEL_MAX_GRAPHEMES): TruncatedLabel {
  const clusters = segmentGraphemes(text);
  if (clusters.length <= max) {
    return { text, truncated: false, graphemeCount: clusters.length };
  }
  const kept = clusters.slice(0, Math.max(0, max - 1)).join('');
  return { text: `${kept}${LABEL_ELLIPSIS}`, truncated: true, graphemeCount: max };
}
