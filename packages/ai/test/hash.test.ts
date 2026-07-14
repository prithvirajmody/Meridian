import { describe, expect, it } from 'vitest';
import { canonicalInputHash, canonicalJson, hashString } from '../src/hash.js';

describe('canonicalJson', () => {
  it('sorts object keys recursively', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ z: { y: 1, x: 2 }, a: 3 })).toBe('{"a":3,"z":{"x":2,"y":1}}');
  });

  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson({ list: [{ b: 1, a: 2 }] })).toBe('{"list":[{"a":2,"b":1}]}');
  });
});

describe('hashString', () => {
  it('matches known SHA-256 vectors', () => {
    expect(hashString('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(hashString('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('canonicalInputHash', () => {
  it('is independent of key order', () => {
    expect(canonicalInputHash({ a: 1, b: 2 })).toBe(canonicalInputHash({ b: 2, a: 1 }));
  });

  it('changes when a value changes', () => {
    expect(canonicalInputHash({ a: 1 })).not.toBe(canonicalInputHash({ a: 2 }));
  });

  it('is a 64-char hex digest', () => {
    expect(canonicalInputHash({ any: 'thing' })).toMatch(/^[0-9a-f]{64}$/);
  });
});
