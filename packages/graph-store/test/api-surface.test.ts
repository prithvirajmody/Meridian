/**
 * API surface snapshot (ROADMAP Phase 1 §12, architecture row): the public
 * runtime surface is a versioned contract (P12) — changing this list is an
 * intentional, reviewed act. Types are checked by tsc; this pins the values.
 */
import { describe, expect, it } from 'vitest';
import * as store from '../src/index.js';

describe('@meridian/graph-store public surface', () => {
  it('exports exactly the committed names', () => {
    expect(Object.keys(store).sort()).toEqual([
      'DEFAULT_LOW_WATER_RATIO',
      'DEFAULT_MAX_RESIDENT_ELEMENTS',
      'HYDRATION_ACTOR',
      'HydrationManager',
      'LOCAL_SITE',
      'applyDelta',
      'compareVersions',
      'composeDeltas',
      'createStore',
      'decodeDelta',
      'decodeDeltaInput',
      'deltaToWire',
      'diffSpaces',
      'formatVersion',
      'initialVersion',
      'invertDelta',
      'invertOp',
      'successorVersion',
      'tokenizeLabel',
      'versionsEqual',
    ]);
  });
});
