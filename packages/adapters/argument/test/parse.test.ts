/**
 * The deterministic segmentation rule (ADR-0034 floor): paragraphs on blank
 * lines, sentences on terminal punctuation, spans anchored to the normalized
 * source text, documented naïveté (abbreviation over-splitting) pinned as
 * behavior, and binary input rejected with a located error.
 */
import { describe, expect, it } from 'vitest';
import { ArgumentParseError, parseEssay } from '../src/index.js';

describe('parseEssay — paragraphs', () => {
  it('splits on blank lines, including whitespace-only lines and CRLF', () => {
    const essay = parseEssay('First para.\n\nSecond para.\r\n \t\r\nThird para.');
    expect(essay.paragraphs.map((p) => p.text)).toEqual(['First para.', 'Second para.', 'Third para.']);
  });

  it('keeps single newlines inside one paragraph', () => {
    const essay = parseEssay('One line.\nSame paragraph still.');
    expect(essay.paragraphs).toHaveLength(1);
    expect(essay.paragraphs[0]!.sentences).toHaveLength(2);
  });

  it('the empty string and blank-only text parse to zero paragraphs', () => {
    expect(parseEssay('').paragraphs).toHaveLength(0);
    expect(parseEssay('\n \n\t\n').paragraphs).toHaveLength(0);
    expect(parseEssay('').title).toBeUndefined();
  });

  it('paragraph spans index the normalized text exactly', () => {
    const text = 'Alpha beta.\n\nGamma delta.';
    const essay = parseEssay(text);
    for (const p of essay.paragraphs) {
      expect(text.slice(p.span[0], p.span[1])).toBe(p.text);
    }
  });
});

describe('parseEssay — sentences', () => {
  it('splits on runs of terminal punctuation followed by whitespace or end', () => {
    const [p] = parseEssay('First one. Second one! Third one?! A trailing fragment').paragraphs;
    expect(p!.sentences.map((s) => s.text)).toEqual([
      'First one.',
      'Second one!',
      'Third one?!',
      'A trailing fragment',
    ]);
  });

  it('over-splits abbreviations by documented design (deterministic floor)', () => {
    const [p] = parseEssay('See Dr. Smith for details.').paragraphs;
    expect(p!.sentences.map((s) => s.text)).toEqual(['See Dr.', 'Smith for details.']);
  });

  it('sentence spans index the normalized text exactly', () => {
    const text = 'One two. Three four.\n\nFive six? Seven.';
    for (const p of parseEssay(text).paragraphs) {
      for (const s of p.sentences) {
        expect(text.slice(s.span[0], s.span[1])).toBe(s.text);
      }
    }
  });

  it('is byte-deterministic: two parses agree structurally', () => {
    const text = 'A b c. D e f!\n\nG h i? J k l. M n o';
    expect(parseEssay(text)).toEqual(parseEssay(text));
  });
});

describe('parseEssay — title', () => {
  it('strips markdown heading markers from the first line and caps at 80 chars', () => {
    expect(parseEssay('## The Title Here\n\nBody.').title).toBe('The Title Here');
    const long = `# ${'x'.repeat(200)}`;
    expect(parseEssay(long).title).toHaveLength(80);
  });

  it('falls back to the first line of plain prose', () => {
    expect(parseEssay('Plain opening line.\nSecond line.').title).toBe('Plain opening line.');
  });
});

describe('parseEssay — failure', () => {
  it('rejects binary (NUL) input with a located error, never a garbage graph', () => {
    expect(() => parseEssay('text with \u0000 inside', 'file.txt')).toThrowError(ArgumentParseError);
    try {
      parseEssay('\u0000', 'file.txt');
      expect.unreachable();
    } catch (e) {
      expect((e as ArgumentParseError).location.uri).toBe('file.txt');
    }
  });
});
