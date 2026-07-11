/**
 * `LayoutCache` unit tests (ADR-0017 "Future implications"; roadmap §11): the
 * cache is keyed `(storeVersion, cutHash, providerId, hintsHash)` and a hit is
 * a **buffer-ref return** — O(1), < 1ms, no recompute. Also covers key
 * sensitivity on all four components, hash determinism, and LRU eviction.
 */
import { describe, expect, it } from 'vitest';
import {
  cacheKeyString,
  gridProvider,
  hashCut,
  hashHints,
  LayoutCache,
  type LayoutCacheKey,
  type LayoutResult,
} from '../src/index.js';
import { cutOf, edge, sizes } from './helpers.js';

async function layout(): Promise<LayoutResult> {
  return gridProvider.compute({
    cut: cutOf('a', 'b', 'c'),
    edges: [edge('a', 'b')],
    sizes: sizes({ a: { width: 60, height: 28 }, b: { width: 60, height: 28 }, c: { width: 60, height: 28 } }),
    hints: {},
  });
}

const key = (over: Partial<LayoutCacheKey> = {}): LayoutCacheKey => ({
  storeVersion: 'v1',
  cutHash: 'cut-abc',
  providerId: 'grid',
  hintsHash: 'h0',
  ...over,
});

describe('cache key hashing (deterministic content hashes)', () => {
  it('hashCut/hashHints are deterministic and discriminating', () => {
    const c1 = cutOf('a', 'b', 'c');
    const c2 = cutOf('a', 'b', 'c');
    const c3 = cutOf('a', 'b', 'd');
    expect(hashCut(c1)).toBe(hashCut(c2));
    expect(hashCut(c1)).not.toBe(hashCut(c3));
    expect(hashHints({ spacing: 10 })).toBe(hashHints({ spacing: 10 }));
    expect(hashHints({ spacing: 10 })).not.toBe(hashHints({ spacing: 11 }));
    expect(hashHints({ direction: 'down' })).not.toBe(hashHints({ direction: 'right' }));
  });

  it('cacheKeyString composes all four components injectively', () => {
    const s = cacheKeyString(key());
    expect(s).toContain('v1');
    expect(s).toContain('cut-abc');
    expect(s).toContain('grid');
    expect(s).toContain('h0');
    // Distinct in any component ⇒ distinct key string.
    expect(cacheKeyString(key())).toBe(cacheKeyString(key()));
    expect(cacheKeyString(key({ providerId: 'tree' }))).not.toBe(cacheKeyString(key()));
    expect(cacheKeyString(key({ cutHash: 'cut-abd' }))).not.toBe(cacheKeyString(key()));
  });
});

describe('LayoutCache get/set semantics', () => {
  it('stores and returns the same LayoutResult by reference', async () => {
    const cache = new LayoutCache();
    const l = await layout();
    expect(cache.get(key())).toBeUndefined();
    cache.set(key(), l);
    expect(cache.get(key())).toBe(l); // identity, not a copy
    expect(cache.has(key())).toBe(true);
    expect(cache.stats()).toEqual({ hits: 1, misses: 1 });
  });

  it('misses when any of the four key components differs', async () => {
    const cache = new LayoutCache();
    cache.set(key(), await layout());
    expect(cache.get(key({ storeVersion: 'v2' }))).toBeUndefined();
    expect(cache.get(key({ cutHash: 'other' }))).toBeUndefined();
    expect(cache.get(key({ providerId: 'tree' }))).toBeUndefined();
    expect(cache.get(key({ hintsHash: 'h1' }))).toBeUndefined();
  });

  it('evicts least-recently-used past capacity', async () => {
    const cache = new LayoutCache(2);
    const l = await layout();
    cache.set(key({ cutHash: 'A' }), l);
    cache.set(key({ cutHash: 'B' }), l);
    cache.get(key({ cutHash: 'A' })); // touch A → B is now LRU
    cache.set(key({ cutHash: 'C' }), l); // evicts B
    expect(cache.has(key({ cutHash: 'A' }))).toBe(true);
    expect(cache.has(key({ cutHash: 'B' }))).toBe(false);
    expect(cache.has(key({ cutHash: 'C' }))).toBe(true);
    expect(cache.size).toBe(2);
  });
});

describe('cache hit is < 1ms (roadmap §11)', () => {
  it('warm hits return in well under a millisecond each', async () => {
    const cache = new LayoutCache();
    const k = key();
    cache.set(k, await layout());
    // Warm up, then measure a batch of hits and assert the *per-hit* mean.
    for (let i = 0; i < 1000; i++) cache.get(k);
    const iterations = 100_000;
    const t0 = performance.now();
    for (let i = 0; i < iterations; i++) {
      const hit = cache.get(k);
      if (hit === undefined) throw new Error('unexpected miss');
    }
    const perHitMs = (performance.now() - t0) / iterations;
    // Each hit is a Map lookup + LRU refresh — orders of magnitude under 1ms.
    expect(perHitMs).toBeLessThan(1);
    console.log(`cache hit: ${(perHitMs * 1000).toFixed(3)} µs/hit (${iterations} hits)`);
  });
});
