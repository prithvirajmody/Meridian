/**
 * Deterministic PRNG + string hashing for the eval harness (Phase 8F).
 *
 * Evals must be byte-stable across runs and machines (ADR-0030 determinism),
 * so nothing here touches `Math.random` or wall-clock time. `mulberry32` is a
 * tiny, well-distributed 32-bit generator seeded by an integer; `hashSeed`
 * turns a string into that integer so fixtures can be seeded by a stable name.
 */

/** FNV-1a → 32-bit unsigned integer seed from a string. */
export function hashSeed(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: deterministic float generator in [0,1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
