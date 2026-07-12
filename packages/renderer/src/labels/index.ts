export {
  LABEL_ELLIPSIS,
  LABEL_MAX_GRAPHEMES,
  segmentGraphemes,
  truncateLabel,
} from './truncate.js';
export type { TruncatedLabel } from './truncate.js';

export {
  coverageFromCodePoints,
  coverageFromRanges,
  labelRenderKind,
} from './render-kind.js';
export type { AtlasCoverage, CodePointRange, LabelRenderKind } from './render-kind.js';

export {
  ATLAS_EXTRA_CODE_POINTS,
  ATLAS_RANGES,
  meridianAtlasCharset,
  meridianAtlasCodePoints,
  meridianAtlasCoverage,
} from './atlas-manifest.js';

export {
  LABEL_CELL_PADDING_CSS_PX,
  LABEL_CELL_SIZE_CSS_PX,
  LABEL_FALLBACK_MAX_LIVE,
  LABEL_GLYPH_ADVANCE_CSS_PX,
  LABEL_LINE_HEIGHT_CSS_PX,
  LABEL_MAX_LIVE,
  LABEL_NOMINAL_SIZE_CSS_PX,
  labelFadeAlpha,
  planLabels,
} from './plan.js';
export type { LabelPlan, LabelPlanInput, LabelPlanOptions, PlannedLabel } from './plan.js';
