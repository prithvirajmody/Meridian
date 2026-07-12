/**
 * Anchor math property tests (ADR-0024), fast-check:
 *  - the point under the cursor maps through the refinement — the mapped point
 *    lies inside R_in;
 *  - zoom-in ∘ zoom-out is the identity up to the rect-to-rect affine;
 *  - the closed-form camera solve puts W′ exactly at the screen anchor A.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { worldToScreen } from '@meridian/view-model';
import { anchorMap, rectContains, solveCamera } from '../src/geometry.js';

const coord = fc.double({ min: -1e4, max: 1e4, noNaN: true, noDefaultInfinity: true });
const extent = fc.double({ min: 1e-3, max: 1e4, noNaN: true, noDefaultInfinity: true });
const rectArb = fc.record({ x: coord, y: coord, width: extent, height: extent });
const unit = fc.double({ min: 0, max: 1, noNaN: true });

describe('anchorMap (ADR-0024)', () => {
  it('a point inside R_out maps to a point inside R_in', () => {
    fc.assert(
      fc.property(rectArb, rectArb, unit, unit, (rOut, rIn, u, v) => {
        const w = { x: rOut.x + u * rOut.width, y: rOut.y + v * rOut.height };
        const mapped = anchorMap(w, rOut, rIn);
        // Inclusive containment with a tiny tolerance for float rounding.
        const tol = 1e-6 * (1 + rIn.width + rIn.height + Math.abs(rIn.x) + Math.abs(rIn.y));
        const padded = { x: rIn.x - tol, y: rIn.y - tol, width: rIn.width + 2 * tol, height: rIn.height + 2 * tol };
        expect(rectContains(padded, mapped)).toBe(true);
      }),
    );
  });

  it('zoom-in ∘ zoom-out round-trips up to the affine (identity)', () => {
    fc.assert(
      fc.property(rectArb, rectArb, unit, unit, (rOut, rIn, u, v) => {
        const w = { x: rOut.x + u * rOut.width, y: rOut.y + v * rOut.height };
        const forward = anchorMap(w, rOut, rIn); // "zoom in": R_out → R_in
        const back = anchorMap(forward, rIn, rOut); // "zoom out": R_in → R_out
        const scale = 1 + rOut.width + rOut.height + Math.abs(rOut.x) + Math.abs(rOut.y);
        expect(back.x).toBeCloseTo(w.x, 6);
        expect(back.y).toBeCloseTo(w.y, 6);
        void scale;
      }),
    );
  });
});

describe('camera solve (ADR-0024)', () => {
  it('worldToScreen(W′, solvedCamera) === anchorScreen A', () => {
    const viewport = fc.record({
      width: fc.double({ min: 1, max: 4000, noNaN: true }),
      height: fc.double({ min: 1, max: 4000, noNaN: true }),
    });
    const scale = fc.double({ min: 1e-3, max: 1e3, noNaN: true, noDefaultInfinity: true });
    fc.assert(
      fc.property(coord, coord, coord, coord, viewport, scale, (wx, wy, ax, ay, vp, s) => {
        const worldIn = { x: wx, y: wy };
        const anchorScreen = { x: ax % vp.width, y: ay % vp.height };
        const camera = solveCamera(worldIn, anchorScreen, vp, s);
        const back = worldToScreen(worldIn, camera, vp);
        expect(back.x).toBeCloseTo(anchorScreen.x, 6);
        expect(back.y).toBeCloseTo(anchorScreen.y, 6);
      }),
    );
  });
});
