import { describe, expect, it } from 'vitest';
import {
  asGraphId,
  asNodeId,
  deriveEdgeId,
  deriveGraphId,
  deriveNodeId,
  MeridianError,
} from '../src/index.js';
import { sha256Hex } from '../src/sha256.js';

const utf8 = (s: string) => new TextEncoder().encode(s);

describe('sha256 (FIPS 180-4 test vectors)', () => {
  it('hashes the empty string', () => {
    expect(sha256Hex(utf8(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
  it('hashes "abc"', () => {
    expect(sha256Hex(utf8('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
  it('hashes a two-block message', () => {
    expect(sha256Hex(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });
  it('hashes exactly one padding boundary (55 and 56 bytes)', () => {
    // Boundary where the length field no longer fits in the same block.
    expect(sha256Hex(utf8('a'.repeat(55)))).toBe(
      '9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318',
    );
    expect(sha256Hex(utf8('a'.repeat(56)))).toBe(
      'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a',
    );
  });
});

describe('ID derivation (ADR-0002)', () => {
  const coords = { domain: 'code', source: 'file:///a.ts', path: ['mod utils', 'fn parse'] };

  it('is deterministic and tag-prefixed: n|g|e + 26 base32 chars', () => {
    const n = deriveNodeId(coords);
    expect(n).toMatch(/^n[a-z2-7]{26}$/);
    expect(deriveNodeId(coords)).toBe(n);
    expect(deriveGraphId(coords)).toMatch(/^g[a-z2-7]{26}$/);
  });

  it('gives a node and its detail graph distinct IDs from the same coords', () => {
    expect(deriveNodeId(coords).slice(1)).toBe(deriveGraphId(coords).slice(1));
    expect(String(deriveNodeId(coords))).not.toBe(String(deriveGraphId(coords)));
  });

  it('is NFC-canonical: composed and decomposed input agree', () => {
    const composed = { domain: 'doc', source: 'café.md', path: ['étude'] };
    const decomposed = { domain: 'doc', source: 'café.md', path: ['étude'] };
    expect(deriveNodeId(composed)).toBe(deriveNodeId(decomposed));
  });

  it('separates segments (no concatenation collisions)', () => {
    expect(deriveNodeId({ domain: 'd', source: 's', path: ['ab'] })).not.toBe(
      deriveNodeId({ domain: 'd', source: 's', path: ['a', 'b'] }),
    );
    expect(deriveNodeId({ domain: 'd', source: 's', path: ['a', 'b'] })).not.toBe(
      deriveNodeId({ domain: 'd', source: 's', path: ['b', 'a'] }),
    );
  });

  it('rejects empty segments and the separator character', () => {
    expect(() => deriveNodeId({ domain: '', source: 's', path: [] })).toThrow(MeridianError);
    expect(() => deriveNodeId({ domain: 'd', source: 's', path: ['a\u001fb'] })).toThrow(
      /U\+001F/,
    );
  });

  it('derives edge IDs with an occurrence discriminator', () => {
    const g = asGraphId('g1');
    const base = { graph: g, kind: 'code:calls', src: asNodeId('na'), dst: asNodeId('nb') };
    expect(deriveEdgeId(base)).toMatch(/^e[a-z2-7]{26}$/);
    expect(deriveEdgeId(base)).toBe(deriveEdgeId({ ...base, occurrence: '' }));
    expect(deriveEdgeId(base)).not.toBe(deriveEdgeId({ ...base, occurrence: '2' }));
    expect(deriveEdgeId(base)).not.toBe(
      deriveEdgeId({ ...base, src: asNodeId('nb'), dst: asNodeId('na') }),
    );
  });

  it('pins the derivation output forever (golden value)', () => {
    // If this changes, every stored ID in every project changes: that is a
    // formatVersion bump + migration (ADR-0002), never a casual edit.
    expect(deriveNodeId(coords)).toMatchInlineSnapshot(`"njjanl7l33xc5ric4gjml62lfw4"`);
  });

  it('asNodeId/asGraphId reject malformed opaque IDs', () => {
    expect(() => asNodeId('')).toThrow(MeridianError);
    expect(() => asNodeId('a\u001fb')).toThrow(MeridianError);
    expect(asNodeId('n-hand-written')).toBe('n-hand-written');
  });
});
