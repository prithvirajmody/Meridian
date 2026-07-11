import { describe, expect, it } from 'vitest';
import {
  LABEL_ELLIPSIS,
  LABEL_MAX_GRAPHEMES,
  segmentGraphemes,
  truncateLabel,
} from '../src/labels/truncate.js';

const COMBINING_E_ACUTE = 'é'; // base + combining acute accent (one cluster)
const ZWJ_FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}'; // man+ZWJ+woman+ZWJ+girl

describe('ADR-0020 grapheme truncation', () => {
  it('leaves a short label untouched', () => {
    const result = truncateLabel('hello world');
    expect(result).toEqual({ text: 'hello world', truncated: false, graphemeCount: 11 });
  });

  it('keeps a label of exactly the cap untouched', () => {
    const source = 'a'.repeat(LABEL_MAX_GRAPHEMES);
    const result = truncateLabel(source);
    expect(result.truncated).toBe(false);
    expect(result.graphemeCount).toBe(LABEL_MAX_GRAPHEMES);
    expect(result.text).toBe(source);
  });

  it('truncates with a trailing ellipsis at the cap', () => {
    const result = truncateLabel('a'.repeat(80));
    expect(result.truncated).toBe(true);
    expect(result.graphemeCount).toBe(LABEL_MAX_GRAPHEMES);
    expect(result.text.endsWith(LABEL_ELLIPSIS)).toBe(true);
    expect(segmentGraphemes(result.text)).toHaveLength(LABEL_MAX_GRAPHEMES);
  });

  it('treats a base + combining mark as one grapheme cluster', () => {
    expect(segmentGraphemes(COMBINING_E_ACUTE.repeat(3))).toHaveLength(3);
    const result = truncateLabel(COMBINING_E_ACUTE.repeat(60));
    expect(result.truncated).toBe(true);
    expect(result.graphemeCount).toBe(LABEL_MAX_GRAPHEMES);
    // Combining marks are never split; the final cluster is the ellipsis.
    expect(result.text.endsWith(LABEL_ELLIPSIS)).toBe(true);
    expect(segmentGraphemes(result.text)).toHaveLength(LABEL_MAX_GRAPHEMES);
  });

  it('treats a ZWJ emoji sequence as one grapheme cluster', () => {
    expect(segmentGraphemes(ZWJ_FAMILY)).toHaveLength(1);
    const result = truncateLabel(ZWJ_FAMILY.repeat(60));
    expect(result.truncated).toBe(true);
    expect(segmentGraphemes(result.text)).toHaveLength(LABEL_MAX_GRAPHEMES);
  });
});
