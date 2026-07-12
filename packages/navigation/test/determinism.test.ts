/**
 * I6 — determinism & purity. Same inputs → deep-equal RefinementMaps and
 * TransitionPlans; nothing in the package reads wall time or randomness.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { deriveRefinementMap } from '../src/refinement.js';
import { planTransition } from '../src/choreographer.js';
import { buildSpace, cutAt, layoutOf, rect } from './helpers.js';

const space = buildSpace([
  { id: 'P', children: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }] },
  { id: 'Q', children: [{ id: 'd1' }, { id: 'd2' }] },
]);

describe('determinism (I6)', () => {
  it('deriveRefinementMap is deterministic (deep-equal)', () => {
    const from = cutAt(space, 0);
    const to = cutAt(space, 1);
    expect(deriveRefinementMap(from, to, space)).toEqual(deriveRefinementMap(from, to, space));
  });

  it('planTransition is deterministic (deep-equal plans)', () => {
    const from = { cut: cutAt(space, 0), layout: layoutOf({ P: rect(0, 0, 100, 100), Q: rect(120, 0, 80, 80) }) };
    const to = {
      cut: cutAt(space, 1),
      layout: layoutOf({
        c1: rect(0, 0, 30, 30),
        c2: rect(35, 0, 30, 30),
        c3: rect(70, 0, 30, 30),
        d1: rect(120, 0, 30, 30),
        d2: rect(155, 0, 30, 30),
      }),
    };
    const ref = deriveRefinementMap(from.cut, to.cut, space);
    expect(planTransition(from, to, ref)).toEqual(planTransition(from, to, ref));
  });
});

describe('purity (I6): no wall clock or randomness in the package', () => {
  it('src contains no Date.now / performance.now / Math.random', () => {
    const srcDir = fileURLToPath(new URL('../src', import.meta.url));
    const forbidden = /Date\.now|performance\.now|Math\.random/;
    for (const file of readdirSync(srcDir)) {
      if (!file.endsWith('.ts')) continue;
      const text = readFileSync(`${srcDir}/${file}`, 'utf8');
      expect(forbidden.test(text), `${file} must not read wall time or randomness`).toBe(false);
    }
    // Sanity: the guard actually inspected files.
    expect(readdirSync(srcDir).filter((f) => f.endsWith('.ts')).length).toBeGreaterThan(3);
  });
});
