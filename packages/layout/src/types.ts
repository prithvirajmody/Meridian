/**
 * Source-compatible re-export. ADR-0015/0022 moved the Layout I/O definitions
 * to `@meridian/view-model` in subphase 5B; layout now implements that contract
 * without importing abstraction or graph-core directly.
 */
export type {
  CompoundNesting,
  LayoutCapabilities,
  LayoutDirection,
  LayoutHints,
  LayoutInput,
  LayoutProvider,
  LayoutResult,
} from '@meridian/view-model';
