import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';

describe('@meridian/view-model public surface', () => {
  it('exports exactly the committed runtime names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'DEFAULT_CAMERA_SCALE_LIMITS',
      'EDGE_FLAG_SELECTED',
      'EDGE_FLAG_SELECTION_ANCHOR',
      'EMPTY_SELECTION',
      'LABEL_ALL_THRESHOLD_CSS_PX',
      'LABEL_CLASS_CONNECTED',
      'LABEL_CLASS_FORCED',
      'LABEL_CLASS_ORDINARY',
      'LABEL_CLASS_SUMMARY',
      'LABEL_CONNECTED_THRESHOLD_CSS_PX',
      'LABEL_SUMMARY_THRESHOLD_CSS_PX',
      'NODE_FLAG_HAS_DETAIL',
      'NODE_FLAG_SELECTED',
      'NODE_FLAG_SELECTION_ANCHOR',
      'buildRenderModel',
      'createCameraState',
      'isLabelEligible',
      'labelTier',
      'panBy',
      'projectedNodeHeight',
      'screenToWorld',
      'worldToScreen',
      'zoomAt',
    ]);
  });
});
