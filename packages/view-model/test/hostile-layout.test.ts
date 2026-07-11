import { describe, expect, it } from 'vitest';
import { buildRenderModel } from '../src/index.js';
import { edge, layoutOf, lodOf, node, spaceOf } from './helpers.js';

describe('hostile layout input', () => {
  it('clamps missing/non-finite/negative positions and routes, returning warnings as data', () => {
    const relation = edge('n-a', 'n-b');
    const key = 'n-a→n-b→test:rel';
    const hostile = {
      x: Number.NaN,
      y: Number.POSITIVE_INFINITY,
      width: -4,
      height: 20,
    };
    const layout = layoutOf(
      { 'n-a': hostile },
      new Map([[key, [{ x: Number.NEGATIVE_INFINITY, y: 7 }, { x: 8, y: Number.NaN }]]]),
    );

    const model = buildRenderModel(
      spaceOf([node('n-a', 'A'), node('n-b', 'B')]),
      lodOf(['n-a', 'n-b'], [relation]),
      layout,
    );

    expect([...model.nodeRects]).toEqual([0, 0, 0, 20, 0, 0, 0, 0]);
    expect([...model.edgeRoutePoints]).toEqual([0, 7, 8, 0]);
    expect(model.bounds).toEqual({ x: 0, y: 0, width: 8, height: 20 });
    expect(model.diagnostics.map((warning) => [warning.code, warning.id, warning.field])).toEqual([
      ['non-finite-position', 'n-a', 'x'],
      ['non-finite-position', 'n-a', 'y'],
      ['negative-size', 'n-a', 'width'],
      ['missing-position', 'n-b', 'rect'],
      ['non-finite-route', key, 'route[0].x'],
      ['non-finite-route', key, 'route[1].y'],
    ]);
    expect(Number.isNaN(hostile.x)).toBe(true); // input was not mutated
    expect(model.nodeRects.every(Number.isFinite)).toBe(true);
    expect(model.edgeRoutePoints.every(Number.isFinite)).toBe(true);
  });
});
