/**
 * RefinementMap derivation (ADR-0023): move/enter/exit classification from
 * containment, over hand-built cut diffs — refinement, coarsening, mixed
 * overrides, sourceless/targetless, empty and identical cuts.
 */
import { describe, expect, it } from 'vitest';
import { asNodeId } from '@meridian/graph-core';
import { deriveRefinementMap } from '../src/refinement.js';
import { buildSpace, cutAt, cutOf } from './helpers.js';

// Forest: P{c1,c2}, Q{d1,d2} at the root graph.
const space = buildSpace([
  { id: 'P', children: [{ id: 'c1' }, { id: 'c2' }] },
  { id: 'Q', children: [{ id: 'd1' }, { id: 'd2' }] },
]);

const id = (s: string) => asNodeId(s);

describe('deriveRefinementMap — cut diffs', () => {
  it('refinement (zoom in, level 0 → 1): children enter from ancestor, parents exit to descendants', () => {
    const from = cutAt(space, 0); // [P, Q]
    const to = cutAt(space, 1); // [c1, c2, d1, d2]
    const ref = deriveRefinementMap(from, to, space);

    expect(ref.move).toEqual([]);
    expect(ref.enter.map((e) => e.id).sort()).toEqual([id('c1'), id('c2'), id('d1'), id('d2')].sort());
    for (const e of ref.enter) {
      expect(e.sourceKind).toBe('ancestor');
    }
    const c1 = ref.enter.find((e) => e.id === id('c1'))!;
    expect(c1.source).toBe(id('P'));
    const d1 = ref.enter.find((e) => e.id === id('d1'))!;
    expect(d1.source).toBe(id('Q'));

    expect(ref.exit.map((x) => x.id).sort()).toEqual([id('P'), id('Q')].sort());
    const p = ref.exit.find((x) => x.id === id('P'))!;
    expect(p.targetKind).toBe('descendants');
    expect(p.targetDescendants).toEqual([id('c1'), id('c2')]);
  });

  it('coarsening (zoom out, level 1 → 0): parents enter from descendants, children exit to ancestor', () => {
    const from = cutAt(space, 1);
    const to = cutAt(space, 0);
    const ref = deriveRefinementMap(from, to, space);

    expect(ref.move).toEqual([]);
    const p = ref.enter.find((e) => e.id === id('P'))!;
    expect(p.sourceKind).toBe('descendants');
    expect(p.sourceDescendants).toEqual([id('c1'), id('c2')]);

    const c1 = ref.exit.find((x) => x.id === id('c1'))!;
    expect(c1.targetKind).toBe('ancestor');
    expect(c1.target).toBe(id('P'));
  });

  it('identical cuts → all moves, empty enter/exit', () => {
    const cut = cutAt(space, 1);
    const ref = deriveRefinementMap(cut, cut, space);
    expect(ref.enter).toEqual([]);
    expect(ref.exit).toEqual([]);
    expect(ref.move).toEqual(cut.members);
  });

  it('empty cuts → empty map', () => {
    const ref = deriveRefinementMap(cutOf([]), cutOf([]), space);
    expect(ref).toEqual({ move: [], enter: [], exit: [] });
  });

  it('mixed-override cuts: P expanded / Q collapsed → P collapsed / Q expanded', () => {
    const from = cutOf(['c1', 'c2', 'Q']); // P expanded, Q collapsed
    const to = cutOf(['P', 'd1', 'd2']); // P collapsed, Q expanded
    const ref = deriveRefinementMap(from, to, space);

    expect(ref.move).toEqual([]);
    // P enters from its from-cut descendants c1,c2.
    const p = ref.enter.find((e) => e.id === id('P'))!;
    expect(p.sourceKind).toBe('descendants');
    expect(p.sourceDescendants).toEqual([id('c1'), id('c2')]);
    // d1,d2 enter from ancestor Q.
    for (const child of ['d1', 'd2']) {
      const e = ref.enter.find((x) => x.id === id(child))!;
      expect(e.sourceKind).toBe('ancestor');
      expect(e.source).toBe(id('Q'));
    }
    // c1,c2 exit to ancestor P.
    for (const child of ['c1', 'c2']) {
      const x = ref.exit.find((e) => e.id === id(child))!;
      expect(x.targetKind).toBe('ancestor');
      expect(x.target).toBe(id('P'));
    }
    // Q exits to its to-cut descendants d1,d2.
    const q = ref.exit.find((e) => e.id === id('Q'))!;
    expect(q.targetKind).toBe('descendants');
    expect(q.targetDescendants).toEqual([id('d1'), id('d2')]);
  });

  it('sourceless enter: from empty → to non-empty', () => {
    const ref = deriveRefinementMap(cutOf([]), cutOf(['P']), space);
    expect(ref.enter).toEqual([{ id: id('P'), sourceKind: 'none' }]);
    expect(ref.exit).toEqual([]);
  });

  it('targetless exit: from non-empty → to empty', () => {
    const ref = deriveRefinementMap(cutOf(['P']), cutOf([]), space);
    expect(ref.exit).toEqual([{ id: id('P'), targetKind: 'none' }]);
    expect(ref.enter).toEqual([]);
  });

  it('node absent from the forest resolves to sourceless (removed by mutation)', () => {
    const ref = deriveRefinementMap(cutOf([]), cutOf(['ghost']), space);
    expect(ref.enter).toEqual([{ id: id('ghost'), sourceKind: 'none' }]);
  });

  it('enter/exit emitted in ascending member order (I6 determinism)', () => {
    const from = cutAt(space, 0);
    const to = cutAt(space, 1);
    const ref = deriveRefinementMap(from, to, space);
    const enterIds = ref.enter.map((e) => e.id);
    expect(enterIds).toEqual([...enterIds].sort());
  });
});
