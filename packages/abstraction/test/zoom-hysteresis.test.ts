/**
 * Zoom↔level mapping and hysteresis (ADR-0012). Fresh resolves are the nominal
 * band; with a prior level, a boundary hover never flaps and a multi-band jump
 * snaps.
 */
import { describe, expect, it } from 'vitest';
import { levelForZoom, nominalLevel, type ZoomPolicy } from '../src/index.js';
import { buildLevelChain } from '../src/index.js';
import { matrixSpace } from './resolver-fixtures.js';

// A 3-level chain (depths 0..2) drives a 2-threshold policy.
const chain = buildLevelChain(matrixSpace());
const policy: ZoomPolicy = { thresholds: [0.33, 0.66], hysteresis: 0.1 };

describe('levelForZoom — fresh (no prevLevel) is the nominal band', () => {
  it('maps z to the band containing it, hysteresis-free', () => {
    expect(levelForZoom(policy, chain, 0.0).level).toBe(0);
    expect(levelForZoom(policy, chain, 0.2).level).toBe(0);
    expect(levelForZoom(policy, chain, 0.33).level).toBe(1); // p1 is the lower edge of band 1
    expect(levelForZoom(policy, chain, 0.5).level).toBe(1);
    expect(levelForZoom(policy, chain, 0.66).level).toBe(2);
    expect(levelForZoom(policy, chain, 1.0).level).toBe(2);
  });

  it('reports the nominal band even when hysteresis holds a different level', () => {
    const r = levelForZoom(policy, chain, 0.67, 1);
    expect(r.nominal).toBe(2);
  });

  it('clamps z outside [0,1]', () => {
    expect(levelForZoom(policy, chain, -5).level).toBe(0);
    expect(levelForZoom(policy, chain, 5).level).toBe(2);
  });

  it('nominalLevel counts thresholds ≤ z, clamped', () => {
    expect(nominalLevel(policy, 0.1, 2)).toBe(0);
    expect(nominalLevel(policy, 0.9, 2)).toBe(2);
    expect(nominalLevel(policy, 0.9, 1)).toBe(1); // clamp to maxLevel
  });
});

describe('levelForZoom — hysteresis: a boundary hover never flaps', () => {
  it('holds prevLevel while oscillating across the upper boundary within h/2', () => {
    // Sitting at level 1, boundary to level 2 is p2=0.66; up-trigger = 0.66+0.05.
    // Oscillate 0.63..0.70 (crosses 0.66 but stays below 0.71): level stays 1.
    for (const z of [0.63, 0.68, 0.64, 0.7, 0.66, 0.69]) {
      expect(levelForZoom(policy, chain, z, 1).level).toBe(1);
    }
  });

  it('only advances once z clears the boundary by h/2', () => {
    expect(levelForZoom(policy, chain, 0.705, 1).level).toBe(1); // not yet
    expect(levelForZoom(policy, chain, 0.72, 1).level).toBe(2); // clears 0.66+0.05
  });

  it('holds prevLevel while oscillating across the lower boundary within h/2', () => {
    // At level 1, boundary down to level 0 is p1=0.33; down-trigger = 0.33-0.05.
    for (const z of [0.30, 0.36, 0.33, 0.29, 0.32]) {
      expect(levelForZoom(policy, chain, z, 1).level).toBe(1);
    }
    expect(levelForZoom(policy, chain, 0.27, 1).level).toBe(0); // clears 0.33-0.05
  });

  it('a full oscillation sequence produces zero flaps inside the sticky band', () => {
    let level = 1;
    const flaps: number[] = [];
    for (const z of [0.6, 0.67, 0.62, 0.69, 0.64, 0.66, 0.63]) {
      const next = levelForZoom(policy, chain, z, level).level;
      if (next !== level) flaps.push(z);
      level = next;
    }
    expect(flaps).toEqual([]);
  });
});

describe('levelForZoom — a multi-band jump snaps to nominal', () => {
  it('teleport from level 0 to a finest-band zoom snaps, not sticky', () => {
    expect(levelForZoom(policy, chain, 0.95, 0).level).toBe(2); // |2-0|>1 → snap
  });

  it('teleport from level 2 down to a coarse zoom snaps', () => {
    expect(levelForZoom(policy, chain, 0.05, 2).level).toBe(0); // |0-2|>1 → snap
  });

  it('an adjacent-band move is subject to hysteresis, not snap', () => {
    // From 0, nominal at z=0.4 is 1 (adjacent); up-trigger from level 0 is
    // p1=0.33+0.05=0.38, so 0.4 advances but 0.37 does not.
    expect(levelForZoom(policy, chain, 0.37, 0).level).toBe(0);
    expect(levelForZoom(policy, chain, 0.4, 0).level).toBe(1);
  });
});
