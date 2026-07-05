/**
 * Override interaction matrix (ADR-0012): every precedence rule as a cell,
 * asserting exact cut membership and the trace reason. Deepest-override-wins is
 * the crux — a descendant pin/expand pierces an ancestor collapse/level.
 */
import { describe, expect, it } from 'vitest';
import {
  buildLevelChain,
  LodResolver,
  type CutReason,
  type LodResult,
  type OverrideKind,
} from '../src/index.js';
import { id, matrixSpace, policy3 } from './resolver-fixtures.js';

const space = matrixSpace();
const chain = buildLevelChain(space);
const resolver = new LodResolver(space, chain, policy3);

// Fresh-resolve zooms that land on base levels 0,1,2 under policy3.
const ZOOM = [0.0, 0.5, 0.9] as const;

function resolveAt(level: 0 | 1 | 2, overrides: Record<string, OverrideKind> = {}): LodResult {
  const map = new Map(Object.entries(overrides).map(([k, v]) => [id(k), v] as const));
  return resolver.resolve({ zoom: ZOOM[level], overrides: map });
}

const membersOf = (r: LodResult): string[] => [...r.cut.members].map(String).sort();
const reasonOf = (r: LodResult, node: string): CutReason | undefined => r.provenance.reasons.get(id(node));

describe('default cut (no overrides) at each level', () => {
  it('level 0 = the two roots, both "level"', () => {
    const r = resolveAt(0);
    expect(membersOf(r)).toEqual(['A', 'B']);
    expect(reasonOf(r, 'A')).toBe('level');
    expect(reasonOf(r, 'B')).toBe('level');
    expect(r.cut.coverage.covers).toBe(true);
  });

  it('level 1 = the middle nodes; ragged leaf A2 reads "leaf"', () => {
    const r = resolveAt(1);
    expect(membersOf(r)).toEqual(['A1', 'A2', 'B1', 'B2']);
    expect(reasonOf(r, 'A1')).toBe('level');
    expect(reasonOf(r, 'A2')).toBe('leaf');
  });

  it('level 2 = all five leaves', () => {
    const r = resolveAt(2);
    expect(membersOf(r)).toEqual(['A11', 'A12', 'A2', 'B1', 'B2']);
  });
});

describe('deepest-override-wins: descendant pierces ancestor', () => {
  it('pin inside a collapsed ancestor opens just that path, siblings stay', () => {
    const r = resolveAt(0, { A: 'collapse', A11: 'pin' });
    expect(membersOf(r)).toEqual(['A11', 'A12', 'A2', 'B']);
    expect(reasonOf(r, 'A11')).toBe('pin');
    expect(reasonOf(r, 'B')).toBe('level');
    expect(r.cut.members).not.toContain(id('A'));
    expect(r.cut.coverage.covers).toBe(true);
  });

  it('expand under a collapse reveals one level of that subtree', () => {
    const r = resolveAt(0, { A: 'collapse', A1: 'expand' });
    expect(membersOf(r)).toEqual(['A11', 'A12', 'A2', 'B']);
    expect(reasonOf(r, 'A11')).toBe('leaf');
  });
});

describe('collapse and expand semantics', () => {
  it('collapse with no deep override holds the node above its level', () => {
    const r = resolveAt(2, { A: 'collapse' });
    expect(membersOf(r)).toEqual(['A', 'B1', 'B2']);
    expect(reasonOf(r, 'A')).toBe('collapse');
  });

  it('expand at the base level descends one level: children read "expand-parent"', () => {
    const r = resolveAt(0, { A: 'expand' });
    expect(membersOf(r)).toEqual(['A1', 'A2', 'B']);
    expect(reasonOf(r, 'A1')).toBe('expand-parent');
    expect(reasonOf(r, 'A2')).toBe('leaf');
    expect(reasonOf(r, 'B')).toBe('level');
  });

  it('expand on a leaf cannot descend — it emits the leaf, never throws', () => {
    const r = resolveAt(0, { B1: 'expand' });
    expect(membersOf(r)).toEqual(['A', 'B1', 'B2']);
    expect(reasonOf(r, 'B1')).toBe('leaf');
  });
});

describe('pin-under-pin: the inner override is shadowed, not applied', () => {
  it('the inner pin is ignored and traced (shadowed), never thrown', () => {
    const r = resolveAt(0, { A1: 'pin', A11: 'pin' });
    expect(membersOf(r)).toEqual(['A1', 'A2', 'B']);
    expect(reasonOf(r, 'A1')).toBe('pin');
    expect(r.provenance.ignoredOverrides).toContainEqual({ node: id('A11'), kind: 'pin', reason: 'shadowed' });
  });
});

describe('focus is inert for the scalar→cut mapping (v1, ADR-0012)', () => {
  it('adding a focus does not change membership', () => {
    const overrides = new Map<ReturnType<typeof id>, OverrideKind>();
    const withoutFocus = resolver.resolve({ zoom: 0.5, overrides });
    const withFocus = resolver.resolve({ zoom: 0.5, overrides, focus: id('A11') });
    expect([...withFocus.cut.members]).toEqual([...withoutFocus.cut.members]);
    expect(withFocus.provenance.focus).toBe(id('A11'));
  });
});
