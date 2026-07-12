/**
 * Unit tests for the CLI's minimal glob matcher (ROADMAP Phase 7 §6 adapter
 * options: include/exclude globs). Pure, no I/O.
 */
import { describe, expect, it } from 'vitest';
import { buildPathFilter, globToRegExp, splitCsv } from '../src/globs.js';

describe('globToRegExp', () => {
  const cases: Array<[string, string, boolean]> = [
    // '**' crosses directory separators
    ['packages/**', 'packages/a/b/c.ts', true],
    ['packages/**', 'packages/x.ts', true],
    ['packages/**', 'apps/x.ts', false],
    ['**/*.d.ts', 'a/b/x.d.ts', true],
    ['**/*.d.ts', 'x.d.ts', true], // '**/' matches zero leading dirs
    ['**/*.d.ts', 'x.ts', false],
    ['**/__tests__/**', 'packages/a/__tests__/x.ts', true],
    ['**/__tests__/**', 'packages/a/src/x.ts', false],
    // '*' stays within one segment
    ['src/*.ts', 'src/a.ts', true],
    ['src/*.ts', 'src/a/b.ts', false],
    // '?' is one non-slash char
    ['a?.ts', 'ab.ts', true],
    ['a?.ts', 'a/.ts', false],
    // regex metacharacters are literal
    ['a.b.ts', 'a.b.ts', true],
    ['a.b.ts', 'axbxts', false],
  ];
  it.each(cases)('%s vs %s → %s', (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });
});

describe('buildPathFilter', () => {
  it('accepts everything when no globs are given', () => {
    const f = buildPathFilter({});
    expect(f.accepts('anything/at/all.ts')).toBe(true);
  });

  it('include: a path must match at least one include glob', () => {
    const f = buildPathFilter({ include: ['packages/**', 'apps/**'] });
    expect(f.accepts('packages/a/x.ts')).toBe(true);
    expect(f.accepts('apps/cli/x.ts')).toBe(true);
    expect(f.accepts('scripts/x.ts')).toBe(false);
  });

  it('exclude wins over include', () => {
    const f = buildPathFilter({ include: ['packages/**'], exclude: ['**/__tests__/**'] });
    expect(f.accepts('packages/a/src/x.ts')).toBe(true);
    expect(f.accepts('packages/a/__tests__/x.ts')).toBe(false);
  });

  it('exclude alone drops matching paths, keeps the rest', () => {
    const f = buildPathFilter({ exclude: ['**/*.d.ts'] });
    expect(f.accepts('a/x.ts')).toBe(true);
    expect(f.accepts('a/x.d.ts')).toBe(false);
  });
});

describe('splitCsv', () => {
  it('splits, trims, and drops empties; undefined → []', () => {
    expect(splitCsv(undefined)).toEqual([]);
    expect(splitCsv('')).toEqual([]);
    expect(splitCsv(' a , b ,, c ')).toEqual(['a', 'b', 'c']);
    expect(splitCsv('typescript,python')).toEqual(['typescript', 'python']);
  });
});
