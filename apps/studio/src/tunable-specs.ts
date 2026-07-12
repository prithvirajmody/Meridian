/**
 * Presentation metadata for the 6E tunables panel: one row per tunable in
 * `NavTunables`, with the human label, the owning ADR, and the legal input
 * window the panel enforces. The *values* live in `@meridian/navigation`
 * (`NAV_TUNABLE_DEFAULTS` — the single canonical defaults module); this file
 * only says how to present and bound-check them, so it can never become a
 * second source of default values.
 *
 * Bounds rationale:
 * - `baseTransitionMs`/`crossfadeMs` cap at `MAX_TRANSITION_MS` — the §16.1
 *   plan-to-settle budget is constitutional, not tunable (ADR-0023).
 * - `stabilityDegradeFloor`/`sourcelessMajority` are fractions in [0, 1].
 * - `overzoomMax`/`keyZoomFactor` must stay ≥ 1 (a factor below 1 inverts the
 *   gesture) and `keyZoomFactor` > 1 to make `+`/`−` actually step.
 */
import { MAX_TRANSITION_MS, type NavTunables } from '@meridian/navigation';

export interface TunableSpec {
  readonly key: keyof NavTunables;
  readonly label: string;
  readonly adr: string;
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

export const TUNABLE_SPECS: readonly TunableSpec[] = [
  {
    key: 'baseTransitionMs',
    label: 'BASE_TRANSITION_MS',
    adr: 'ADR-0023',
    unit: 'ms',
    min: 0,
    max: MAX_TRANSITION_MS,
    step: 10,
  },
  {
    key: 'crossfadeMs',
    label: 'CROSSFADE_MS',
    adr: 'ADR-0023',
    unit: 'ms',
    min: 0,
    max: MAX_TRANSITION_MS,
    step: 10,
  },
  {
    key: 'maxAnimatedNodes',
    label: 'MAX_ANIMATED_NODES',
    adr: 'ADR-0023',
    unit: 'nodes',
    min: 0,
    max: 100_000,
    step: 100,
  },
  {
    key: 'stabilityDegradeFloor',
    label: 'STABILITY_DEGRADE_FLOOR',
    adr: 'ADR-0023',
    unit: 'score',
    min: 0,
    max: 1,
    step: 0.05,
  },
  {
    key: 'sourcelessMajority',
    label: 'SOURCELESS_MAJORITY',
    adr: 'ADR-0023',
    unit: 'fraction',
    min: 0,
    max: 1,
    step: 0.05,
  },
  {
    key: 'anchorSnapFactor',
    label: 'ANCHOR_SNAP',
    adr: 'ADR-0024',
    unit: '×Λ',
    min: 0,
    max: 10,
    step: 0.1,
  },
  {
    key: 'overzoomMax',
    label: 'OVERZOOM_MAX',
    adr: 'ADR-0025',
    unit: '×',
    min: 1,
    max: 32,
    step: 0.5,
  },
  {
    key: 'frameMargin',
    label: 'FRAME_MARGIN',
    adr: 'ADR-0025',
    unit: 'fraction',
    min: 0,
    max: 0.5,
    step: 0.01,
  },
  {
    key: 'keyZoomFactor',
    label: 'KEY_ZOOM_FACTOR',
    adr: 'ADR-0025',
    unit: '×',
    min: 1.01,
    max: 4,
    step: 0.05,
  },
  {
    key: 'readableLeafPx',
    label: 'READABLE_LEAF_PX',
    adr: 'ADR-0025',
    unit: 'px',
    min: 8,
    max: 1024,
    step: 8,
  },
];

const SPEC_BY_KEY = new Map<keyof NavTunables, TunableSpec>(
  TUNABLE_SPECS.map((spec) => [spec.key, spec]),
);

/** Validate one tunable edit against its spec window. Non-finite values are
 * rejected (`undefined`); finite values clamp into `[min, max]`. */
export function sanitizeTunable(key: keyof NavTunables, value: number): number | undefined {
  const spec = SPEC_BY_KEY.get(key);
  if (spec === undefined || !Number.isFinite(value)) return undefined;
  return Math.min(spec.max, Math.max(spec.min, value));
}
