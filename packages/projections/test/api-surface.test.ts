import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';

describe('@meridian/projections public surface', () => {
  it('exports exactly the committed runtime names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'MAP_PROJECTION',
      'MapProjection',
      'OUTLINE_PROJECTION',
      'OutlineProjection',
      'ProjectionRegistry',
    ]);
  });
});
