import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';

describe('@meridian/projections public surface', () => {
  it('exports exactly the committed runtime names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'MAP_PROJECTION',
      'MATRIX_GUTTER_LEFT_PX',
      'MATRIX_GUTTER_TOP_PX',
      'MATRIX_LABEL_MIN_CELL_PX',
      'MATRIX_MAX_CELL_PX',
      'MATRIX_MIN_CELL_PX',
      'MATRIX_PROJECTION',
      'MapProjection',
      'MatrixProjection',
      'OUTLINE_PROJECTION',
      'OutlineProjection',
      'ProjectionRegistry',
      'TIMELINE_AXIS_HEIGHT_PX',
      'TIMELINE_GUTTER_LEFT_PX',
      'TIMELINE_LANE_MAX_PX',
      'TIMELINE_LANE_MIN_PX',
      'TIMELINE_PROJECTION',
      'TimelineProjection',
      'orderMatrixNodes',
      'timelineEvents',
      'timelineTickLabel',
    ]);
  });
});
