/**
 * Anchor-node selection, refinement-image derivation, degenerate-extent
 * handling, and the composed anchor solve (ADR-0024) as unit cases.
 */
import { describe, expect, it } from 'vitest';
import { asNodeId } from '@meridian/graph-core';
import { worldToScreen } from '@meridian/view-model';
import { anchorMap } from '../src/geometry.js';
import { refinementImageRect, selectAnchorNode, solveAnchoredCamera } from '../src/anchor.js';
import { deriveRefinementMap } from '../src/refinement.js';
import { buildSpace, cutAt, cutOf, layoutOf, rect } from './helpers.js';

const id = (s: string) => asNodeId(s);

describe('selectAnchorNode (ADR-0024)', () => {
  const cut = cutOf(['big', 'small']);
  const layout = layoutOf({ big: rect(0, 0, 100, 100), small: rect(10, 10, 20, 20) });

  it('picks the smallest containing rect', () => {
    const sel = selectAnchorNode(cut, layout, { x: 15, y: 15 }, 10);
    expect(sel).toEqual({ node: id('small'), snapped: false });
  });

  it('picks the sole containing rect when only one contains the point', () => {
    const sel = selectAnchorNode(cut, layout, { x: 90, y: 90 }, 10);
    expect(sel.node).toBe(id('big'));
  });

  it('breaks ties by ascending NodeId (equal-area overlap)', () => {
    const c = cutOf(['b', 'a']);
    const l = layoutOf({ a: rect(0, 0, 20, 20), b: rect(0, 0, 20, 20) });
    expect(selectAnchorNode(c, l, { x: 5, y: 5 }, 10).node).toBe(id('a'));
  });

  it('snaps to a near-miss node within ANCHOR_SNAP = 0.5·Λ', () => {
    const c = cutOf(['n']);
    const l = layoutOf({ n: rect(0, 0, 10, 10) });
    // Point 2 units right of the rect; Λ = 10 → snap radius 5 → snaps.
    expect(selectAnchorNode(c, l, { x: 12, y: 5 }, 10)).toEqual({ node: id('n'), snapped: true });
    // Point 8 units away with Λ = 10 → snap radius 5 → empty space.
    expect(selectAnchorNode(c, l, { x: 18, y: 5 }, 10)).toEqual({ node: undefined, snapped: false });
  });
});

describe('anchorMap degenerate extents (ADR-0024)', () => {
  it('a zero-width R_out maps to R_in center on that axis', () => {
    const rOut = rect(5, 0, 0, 100); // zero width
    const rIn = rect(0, 0, 40, 40);
    const mapped = anchorMap({ x: 5, y: 50 }, rOut, rIn);
    expect(mapped.x).toBeCloseTo(20, 9); // R_in center x
    expect(mapped.y).toBeCloseTo(20, 9); // normalized y = 0.5
  });
});

describe('refinementImageRect (ADR-0024)', () => {
  const space = buildSpace([{ id: 'P', children: [{ id: 'c1' }, { id: 'c2' }] }]);

  it('a persisting move maps to its own incoming rect', () => {
    const cut = cutAt(space, 1);
    const ref = deriveRefinementMap(cut, cut, space);
    const toLayout = layoutOf({ c1: rect(0, 0, 40, 40), c2: rect(60, 60, 40, 40) });
    expect(refinementImageRect(id('c1'), ref, toLayout)).toEqual(rect(0, 0, 40, 40));
  });

  it('zoom-out (ancestor target): image is the covering ancestor rect', () => {
    const from = cutAt(space, 1);
    const to = cutAt(space, 0);
    const ref = deriveRefinementMap(from, to, space);
    const toLayout = layoutOf({ P: rect(10, 10, 80, 80) });
    expect(refinementImageRect(id('c1'), ref, toLayout)).toEqual(rect(10, 10, 80, 80));
  });

  it('zoom-in (descendants target): image is the bbox of entering descendants', () => {
    const from = cutAt(space, 0);
    const to = cutAt(space, 1);
    const ref = deriveRefinementMap(from, to, space);
    const toLayout = layoutOf({ c1: rect(0, 0, 40, 40), c2: rect(60, 60, 40, 40) });
    expect(refinementImageRect(id('P'), ref, toLayout)).toEqual(rect(0, 0, 100, 100));
  });

  it('a targetless exit has no image', () => {
    const ref = deriveRefinementMap(cutOf(['P']), cutOf([]), space);
    expect(refinementImageRect(id('P'), ref, layoutOf({}))).toBeUndefined();
  });
});

describe('solveAnchoredCamera (ADR-0024)', () => {
  const space = buildSpace([{ id: 'P', children: [{ id: 'c1' }, { id: 'c2' }] }]);
  const viewport = { width: 800, height: 600 };

  it('refinement path: W′ lands under the screen anchor and W′ is inside R_in', () => {
    const from = cutAt(space, 0);
    const to = cutAt(space, 1);
    const ref = deriveRefinementMap(from, to, space);
    const fromLayout = layoutOf({ P: rect(0, 0, 100, 100) });
    const toLayout = layoutOf({ c1: rect(0, 0, 40, 40), c2: rect(60, 60, 40, 40) });
    const anchorScreen = { x: 500, y: 320 };

    const sol = solveAnchoredCamera({
      worldOut: { x: 25, y: 25 }, // inside P, top-left quadrant
      anchorScreen,
      viewport,
      scaleIn: 3,
      fromCut: from,
      fromLayout,
      toLayout,
      refinement: ref,
      lambda: 10,
    });

    expect(sol.mode).toBe('refinement');
    expect(sol.anchorNode).toBe(id('P'));
    // W′ maps into R_in = bbox(c1,c2) = (0,0,100,100).
    expect(sol.worldIn.x).toBeGreaterThanOrEqual(0);
    expect(sol.worldIn.x).toBeLessThanOrEqual(100);
    // The solved camera puts W′ exactly under the screen anchor.
    const back = worldToScreen(sol.worldIn, sol.camera, viewport);
    expect(back.x).toBeCloseTo(anchorScreen.x, 6);
    expect(back.y).toBeCloseTo(anchorScreen.y, 6);
    expect(sol.camera.scale).toBe(3); // scale passed through untouched
  });

  it('empty space → geometric fallback (W′ = W), located reason', () => {
    const from = cutAt(space, 0);
    const ref = deriveRefinementMap(from, cutAt(space, 1), space);
    const fromLayout = layoutOf({ P: rect(0, 0, 100, 100) });
    const sol = solveAnchoredCamera({
      worldOut: { x: 500, y: 500 }, // far outside P
      anchorScreen: { x: 100, y: 100 },
      viewport,
      scaleIn: 2,
      fromCut: from,
      fromLayout,
      toLayout: layoutOf({ c1: rect(0, 0, 40, 40), c2: rect(60, 60, 40, 40) }),
      refinement: ref,
      lambda: 10,
    });
    expect(sol.mode).toBe('geometric');
    expect(sol.fallback).toBe('empty-space');
    expect(sol.worldIn).toEqual(sol.worldOut);
  });
});
