/** ADR-0010's deliberately narrow range grammar: exact and caret only. */
import { describe, expect, it } from 'vitest';
import { isValidRange, satisfies } from '../src/semver.js';

describe('isValidRange', () => {
  it('accepts exact and caret, rejects everything else', () => {
    expect(isValidRange('0.1.0')).toBe(true);
    expect(isValidRange('^0.1.0')).toBe(true);
    expect(isValidRange('^1.2.3')).toBe(true);
    expect(isValidRange('~0.1.0')).toBe(false);
    expect(isValidRange('>=0.1.0')).toBe(false);
    expect(isValidRange('0.1')).toBe(false);
    expect(isValidRange('*')).toBe(false);
    expect(isValidRange('')).toBe(false);
  });
});

describe('satisfies', () => {
  it('exact requires equality', () => {
    expect(satisfies('0.1.0', '0.1.0')).toBe(true);
    expect(satisfies('0.1.1', '0.1.0')).toBe(false);
  });

  it('caret with major > 0 allows minor/patch growth', () => {
    expect(satisfies('1.2.3', '^1.2.3')).toBe(true);
    expect(satisfies('1.3.0', '^1.2.3')).toBe(true);
    expect(satisfies('1.2.2', '^1.2.3')).toBe(false);
    expect(satisfies('2.0.0', '^1.2.3')).toBe(false);
  });

  it('caret at 0.x pins the minor (npm convention, ADR-0010)', () => {
    expect(satisfies('0.2.1', '^0.2.1')).toBe(true);
    expect(satisfies('0.2.9', '^0.2.1')).toBe(true);
    expect(satisfies('0.3.0', '^0.2.1')).toBe(false);
    expect(satisfies('0.2.0', '^0.2.1')).toBe(false);
  });

  it('caret at 0.0.x is exact', () => {
    expect(satisfies('0.0.3', '^0.0.3')).toBe(true);
    expect(satisfies('0.0.4', '^0.0.3')).toBe(false);
  });
});
