/**
 * `LayoutCache` (ROADMAP Phase 4 §7; ADR-0017 "Future implications"): keyed
 * `(storeVersion, cutHash, providerId, hintsHash)`, it stores a computed
 * `LayoutResult` (positions backed by the returned `Float64Array`) so a repeat
 * request is a **buffer-ref return — a cache hit is O(1), < 1ms** (roadmap
 * §11), never a recompute and never a worker round-trip.
 *
 * Pure, isomorphic. The four key components are supplied by the caller: the
 * host/CLI holds `storeVersion` (a graph-store version) and computes `cutHash`
 * and `hintsHash` via the helpers here, so the cache is self-contained and
 * testable. Eviction is a bounded LRU (insertion/most-recent-get moved to the
 * back); the default ceiling is small because each entry pins typed arrays.
 */
import type { Cut } from '@meridian/view-model';
import type { LayoutHints, LayoutResult } from '../types.js';

/** The four-part cache key (ADR-0017). `storeVersion` is opaque to the cache
 * (any stable string/number identity of the immutable snapshot). */
export interface LayoutCacheKey {
  readonly storeVersion: string | number;
  readonly cutHash: string;
  readonly providerId: string;
  readonly hintsHash: string;
}

/** FNV-1a (32-bit) over a string → 8-char hex. Deterministic, allocation-light
 * — a content hash, not a cryptographic one. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** A stable content hash of a cut's *identity* for caching: its base level and
 * ascending member list (the geometry-determining inputs a provider reads). */
export function hashCut(cut: Cut): string {
  return fnv1a(`${cut.level}\u0000${cut.members.join('\u0000')}`);
}

/** A stable content hash of the presentation hints (direction/spacing/seed). */
export function hashHints(hints: LayoutHints): string {
  return fnv1a(`${hints.direction ?? ''}\u0000${hints.spacing ?? ''}\u0000${hints.seed ?? ''}`);
}

/** The flat string form of a {@link LayoutCacheKey}. Components are joined by a
 * NUL — collision-proof, since none of the four parts (a version, two hex
 * content hashes, a provider id) can contain one. */
export const CACHE_KEY_SEP = '\u0000';
export function cacheKeyString(key: LayoutCacheKey): string {
  return [key.storeVersion, key.cutHash, key.providerId, key.hintsHash].join(CACHE_KEY_SEP);
}

/** Default maximum number of cached layouts (each pins typed arrays). */
export const DEFAULT_CACHE_CAPACITY = 64;

/**
 * A bounded LRU over computed layouts. `get`/`set`/`has` are O(1); a hit
 * returns the stored `LayoutResult` **by reference** (no copy, no recompute).
 */
export class LayoutCache {
  private readonly map = new Map<string, LayoutResult>();
  private hits = 0;
  private misses = 0;

  constructor(private readonly capacity: number = DEFAULT_CACHE_CAPACITY) {}

  /** Look up a layout; O(1) buffer-ref return on hit (< 1ms). Refreshes LRU. */
  get(key: LayoutCacheKey): LayoutResult | undefined {
    const k = cacheKeyString(key);
    const hit = this.map.get(k);
    if (hit === undefined) {
      this.misses++;
      return undefined;
    }
    // Refresh recency: delete + re-set moves the entry to the back.
    this.map.delete(k);
    this.map.set(k, hit);
    this.hits++;
    return hit;
  }

  /** True iff `key` is cached (does not affect hit/miss counters or recency). */
  has(key: LayoutCacheKey): boolean {
    return this.map.has(cacheKeyString(key));
  }

  /** Store a layout, evicting the least-recently-used entry past capacity. */
  set(key: LayoutCacheKey, layout: LayoutResult): void {
    const k = cacheKeyString(key);
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, layout);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  /** Drop every entry. */
  clear(): void {
    this.map.clear();
  }

  /** Current entry count. */
  get size(): number {
    return this.map.size;
  }

  /** Cumulative `{ hits, misses }` for host stats. */
  stats(): { readonly hits: number; readonly misses: number } {
    return { hits: this.hits, misses: this.misses };
  }
}
