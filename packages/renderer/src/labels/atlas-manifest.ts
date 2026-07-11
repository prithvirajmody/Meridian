/**
 * The single source of truth for MSDF atlas coverage (ADR-0020 §fast path).
 * Both the pure `labelRenderKind` routing and the checked-in font-regen script
 * read this manifest, so the coverage table can never drift from the baked atlas.
 *
 * Coverage: ASCII, Latin-1 Supplement, and the General-Punctuation code points
 * for which DejaVu Sans has ordinary (non-shaping) glyphs. Everything else —
 * CJK, Arabic, emoji, combining sequences — routes to the bounded fallback.
 */
import { coverageFromCodePoints, type AtlasCoverage, type CodePointRange } from './render-kind.js';

/** Inclusive contiguous ranges baked into the atlas. */
export const ATLAS_RANGES: readonly CodePointRange[] = [
  [0x20, 0x7e], // ASCII printable
  [0xa0, 0xff], // Latin-1 Supplement
];

/** Individually-selected General Punctuation code points with ordinary glyphs. */
export const ATLAS_EXTRA_CODE_POINTS: readonly number[] = [
  0x2013, // en dash
  0x2014, // em dash
  0x2018, // left single quote
  0x2019, // right single quote
  0x201c, // left double quote
  0x201d, // right double quote
  0x2022, // bullet
  0x2026, // horizontal ellipsis (used by label truncation)
];

/** Every code point the atlas is required to contain. */
export function meridianAtlasCodePoints(): number[] {
  const codePoints: number[] = [];
  for (const [start, end] of ATLAS_RANGES) {
    for (let codePoint = start; codePoint <= end; codePoint++) codePoints.push(codePoint);
  }
  return [...codePoints, ...ATLAS_EXTRA_CODE_POINTS];
}

/** Coverage predicate for {@link labelRenderKind}. */
export function meridianAtlasCoverage(): AtlasCoverage {
  return coverageFromCodePoints(meridianAtlasCodePoints());
}

/** The exact charset string the font-regen generator must bake. */
export function meridianAtlasCharset(): string {
  return meridianAtlasCodePoints()
    .map((codePoint) => String.fromCodePoint(codePoint))
    .join('');
}
