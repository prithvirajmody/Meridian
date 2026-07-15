/**
 * Deterministic essay segmentation — the argument domain's AI-less floor
 * (ADR-0034, §7.3: "maximal enrichment reliance with a paragraph/sentence
 * skeleton floor"). Pure text → paragraphs → sentences, with character spans
 * into the newline-normalized (`\r\n` → `\n`) source text so every skeleton
 * element carries source provenance (P10).
 *
 * The segmentation is a documented deterministic rule, not NLP:
 *
 * - **Paragraphs** are maximal runs of non-blank lines, split on blank lines
 *   (lines that are empty after trimming). Markdown heading markers (`#`)
 *   are *content*, not structure — a heading line is a (short) paragraph;
 *   only the essay title strips them. Refining prose structure is exactly
 *   the work AI enrichment exists for; the floor states only what character
 *   positions prove.
 * - **Sentences** end at a run of `.`/`!`/`?` followed by whitespace or
 *   end-of-paragraph. Abbreviations ("e.g. ", "Dr. ") therefore over-split;
 *   that is accepted floor behavior (byte-stable, language-agnostic), not a
 *   defect to patch with heuristics that would cost determinism guarantees.
 *
 * NUL bytes mean the input is binary, not text — a located rejection (§7.4
 * crash containment), never a garbage graph.
 */
import { ArgumentParseError } from './errors.js';

/** One segmented sentence, with its span into the original text. */
export interface RawSentence {
  readonly text: string;
  /** `[start, end)` character offsets into the original source text. */
  readonly span: readonly [number, number];
}

/** One segmented paragraph and its sentences. */
export interface RawParagraph {
  readonly text: string;
  readonly span: readonly [number, number];
  readonly sentences: readonly RawSentence[];
}

export interface ParsedEssay {
  /** Essay title: the first line of the first paragraph, `#` markers and
   * surrounding whitespace stripped, capped at 80 characters. */
  readonly title: string | undefined;
  readonly paragraphs: readonly RawParagraph[];
}

export function containsNul(text: string): boolean {
  return text.includes('\u0000');
}

const TITLE_CAP = 80;

function titleOf(first: RawParagraph | undefined): string | undefined {
  if (first === undefined) return undefined;
  const line = first.text.split('\n', 1)[0] ?? '';
  const stripped = line.replace(/^#+\s*/, '').trim();
  if (stripped.length === 0) return undefined;
  return stripped.length > TITLE_CAP ? stripped.slice(0, TITLE_CAP) : stripped;
}

/** Split one paragraph into sentences (rule in the module doc). Offsets are
 * relative to the original text via the paragraph's own start offset. */
function splitSentences(text: string, base: number): RawSentence[] {
  const sentences: RawSentence[] = [];
  const boundary = /[.!?]+(?=\s|$)/g;
  let cursor = 0;
  for (const match of text.matchAll(boundary)) {
    const end = match.index + match[0].length;
    const raw = text.slice(cursor, end);
    pushTrimmed(sentences, raw, base + cursor);
    cursor = end;
  }
  if (cursor < text.length) pushTrimmed(sentences, text.slice(cursor), base + cursor);
  return sentences;
}

/** Trim a raw slice while keeping its span anchored to the original text. */
function pushTrimmed(out: RawSentence[], raw: string, rawStart: number): void {
  const leading = raw.length - raw.trimStart().length;
  const text = raw.trim();
  if (text.length === 0) return;
  const start = rawStart + leading;
  out.push({ text, span: [start, start + text.length] });
}

/**
 * Segment `text` into the deterministic paragraph/sentence skeleton.
 * Throws {@link ArgumentParseError} only for binary (NUL-carrying) input;
 * every genuine text — including the empty string — parses to a valid
 * (possibly empty) essay.
 */
export function parseEssay(text: string, uri?: string): ParsedEssay {
  if (containsNul(text)) {
    throw new ArgumentParseError('source text is binary (contains a NUL byte)', {
      ...(uri !== undefined ? { uri } : {}),
    });
  }
  const normalized = text.replace(/\r\n/g, '\n');

  const paragraphs: RawParagraph[] = [];
  // Paragraph boundaries: runs of lines that are blank after trimming.
  const blank = /\n[ \t]*\n+/g;
  let cursor = 0;
  const closeParagraph = (rawStart: number, rawEnd: number) => {
    const raw = normalized.slice(rawStart, rawEnd);
    const leading = raw.length - raw.trimStart().length;
    const body = raw.trim();
    if (body.length === 0) return;
    const start = rawStart + leading;
    paragraphs.push({
      text: body,
      span: [start, start + body.length],
      sentences: splitSentences(body, start),
    });
  };
  for (const match of normalized.matchAll(blank)) {
    closeParagraph(cursor, match.index);
    cursor = match.index + match[0].length;
  }
  closeParagraph(cursor, normalized.length);

  return { title: titleOf(paragraphs[0]), paragraphs };
}
