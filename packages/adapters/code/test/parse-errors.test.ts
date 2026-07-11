/**
 * 7B smoke: error-tolerant parse of syntax-error sources yields partial trees,
 * flagged (SUBPHASES §7B test row 3; roadmap §12 failure-case row).
 */
import { describe, expect, it } from 'vitest';
import {
  createParserRuntime,
  MAX_REPORTED_SYNTAX_ERRORS,
  parseSource,
  type CodeLanguage,
  type ParserRuntime,
} from '../src/index.js';
import { nodeGrammarSource } from './node-grammar-source.js';

let runtime: ParserRuntime | undefined;
async function parse(language: CodeLanguage, text: string) {
  runtime ??= await createParserRuntime({ readGrammar: nodeGrammarSource });
  const parser = await runtime.parser(language);
  const { tree, outcome } = parseSource(parser, language, text);
  tree.delete();
  parser.delete();
  return outcome;
}

const BROKEN_TS = `
export function ok(): number { return 1; }
const = {{{                      // <- broken declaration
export function alsoOk(): number { return 2; }
`;

const BROKEN_PY = `
def ok():
    return 1

def broken(:
    return 2

def also_ok():
    return 3
`;

describe('error-tolerant parsing', () => {
  it('TypeScript syntax error → partial tree, flagged, healthy siblings intact', async () => {
    const outcome = await parse('typescript', BROKEN_TS);
    expect(outcome.hasErrors).toBe(true);
    expect(outcome.errorCount).toBeGreaterThan(0);
    expect(outcome.errors.length).toBeGreaterThan(0);
    expect(outcome.errorsTruncated).toBe(false);
    // Partial, not empty: the two valid functions still parse around the hole.
    expect(outcome.rootType).toBe('program');
    expect(outcome.nodeCount).toBeGreaterThan(20);
    // Spans are located and sane.
    for (const span of outcome.errors) {
      expect(span.endIndex).toBeGreaterThanOrEqual(span.startIndex);
      expect(span.start.row).toBeGreaterThanOrEqual(0);
    }
  });

  it('Python syntax error → partial tree, flagged, healthy siblings intact', async () => {
    const outcome = await parse('python', BROKEN_PY);
    expect(outcome.hasErrors).toBe(true);
    expect(outcome.errorCount).toBeGreaterThan(0);
    expect(outcome.rootType).toBe('module');
    expect(outcome.nodeCount).toBeGreaterThan(20);
  });

  it('valid sources in both languages carry no error flag', async () => {
    for (const [language, text] of [
      ['typescript', 'const x: number = 1;\n'],
      ['python', 'x = 1\n'],
    ] as const) {
      const outcome = await parse(language, text);
      expect(outcome.hasErrors).toBe(false);
      expect(outcome.errorCount).toBe(0);
      expect(outcome.errors).toEqual([]);
    }
  });

  it('empty source parses cleanly (zero-content file is not an error)', async () => {
    const outcome = await parse('typescript', '');
    expect(outcome.hasErrors).toBe(false);
    expect(outcome.rootType).toBe('program');
  });

  it('error-span flood is capped; exact count survives the cap', async () => {
    // Hundreds of separated broken statements → many distinct ERROR regions.
    const outcome = await parse(
      'typescript',
      Array.from({ length: 300 }, (_, i) => `const ok${i} = ${i};\nconst = %%% ;`).join('\n'),
    );
    expect(outcome.hasErrors).toBe(true);
    expect(outcome.errors.length).toBeLessThanOrEqual(MAX_REPORTED_SYNTAX_ERRORS);
    expect(outcome.errorCount).toBeGreaterThanOrEqual(outcome.errors.length);
    if (outcome.errorCount > outcome.errors.length) {
      expect(outcome.errorsTruncated).toBe(true);
    }
  });
});
