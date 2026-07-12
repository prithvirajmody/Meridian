/**
 * The stability scorer (ADR-0016) — **relocated to `@meridian/view-model` at
 * subphase 6B** and re-exported here so layout's public surface and its
 * internal callers (`grid`/`tree`/`elk-layered`/`d3-force`) are unchanged.
 *
 * The scorer is a pure function of `LayoutResult` (a view-model type), so its
 * home moved into the presentation waist that owns that type — the same
 * type-only relocation pattern ADR-0015 used for the geometry types at 5B.
 * `@meridian/navigation` (deps: abstraction, view-model — §20; may not import
 * layout) consumes it from view-model. Behaviour is byte-identical; CI still
 * recomputes `stability` independently of any provider (ADR-0016 "Purity").
 */
export {
  characteristicLength,
  STABILITY_EPSILON,
  STABILITY_RAMP,
  stabilityScore,
} from '@meridian/view-model';
export type { StabilityScore } from '@meridian/view-model';
