/**
 * ID coordinate mapping & discriminators (7C, ADR-0028) — pure, no grammar.
 * Exercises the discriminator rules directly on hand-built declarations:
 * signature-hash reorder stability, `~n` only for true duplicates, and the
 * default-export / binding-name segment rules (the latter two via the walk in
 * mapping.test.ts; the discriminator algebra lives here).
 */
import { describe, expect, it } from 'vitest';
import { assignSegments, fnv1a, signatureHash } from '../src/index.js';
import type { RawDecl, RawSignature } from '../src/index.js';

function fn(name: string, sig: Partial<RawSignature> & { paramTypeList?: string[] }): RawDecl {
  const signature: RawSignature = {
    params: sig.params ?? (sig.paramTypeList?.length ?? 0),
    signature: sig.signature ?? '()',
    paramTypeList: sig.paramTypeList ?? [],
    returns: sig.returns ?? '',
    async: sig.async ?? false,
    generator: sig.generator ?? false,
    static: sig.static ?? false,
    abstract: sig.abstract ?? false,
    ...(sig.accessibility !== undefined ? { accessibility: sig.accessibility } : {}),
  };
  return { kind: 'function', name, span: [0, 0], exported: false, defaultExport: false, signature, sigHash: signatureHash(signature), children: [] };
}

function cls(name: string): RawDecl {
  return { kind: 'class', name, span: [0, 0], exported: false, defaultExport: false, sigHash: '', children: [] };
}

describe('assignSegments — ADR-0028 discriminators', () => {
  it('a unique name is its own bare segment', () => {
    const [a, b] = assignSegments([fn('alpha', {}), cls('Beta')]);
    expect(a!.segment).toBe('alpha');
    expect(a!.duplicate).toBe(false);
    expect(b!.segment).toBe('Beta');
  });

  it('overloads (same name, distinct signatures) get #hash, never ~n', () => {
    const decls = [
      fn('parse', { paramTypeList: ['string'], signature: '(input: string)' }),
      fn('parse', { paramTypeList: ['number'], signature: '(input: number)' }),
      fn('parse', { paramTypeList: ['boolean'], signature: '(input: boolean)' }),
    ];
    const segs = assignSegments(decls);
    for (const s of segs) {
      expect(s.segment.startsWith('parse#')).toBe(true);
      expect(s.segment.includes('~')).toBe(false);
      expect(s.duplicate).toBe(false);
    }
    // Three distinct segments.
    expect(new Set(segs.map((s) => s.segment)).size).toBe(3);
  });

  it('return-type-only overloads are distinct (open-Q1: return type in the hash)', () => {
    const segs = assignSegments([
      fn('read', { returns: 'string' }),
      fn('read', { returns: 'number' }),
    ]);
    expect(new Set(segs.map((s) => s.segment)).size).toBe(2);
    expect(segs.every((s) => !s.duplicate)).toBe(true);
  });

  it('adding an overload does not renumber existing ones (reorder-stable)', () => {
    const a = fn('f', { paramTypeList: ['string'], signature: '(a: string)' });
    const b = fn('f', { paramTypeList: ['number'], signature: '(a: number)' });
    const c = fn('f', { paramTypeList: ['boolean'], signature: '(a: boolean)' });
    const seg = (decls: RawDecl[], target: RawDecl) =>
      assignSegments(decls).find((s) => s.decl === target)!.segment;
    // b's segment is the same whether the list is [a,b] or [b,a,c] (keyed by its
    // own signature hash, not its position).
    expect(seg([a, b], b)).toBe(seg([b, a, c], b));
    expect(seg([a, b], a)).toBe(seg([c, b, a], a));
  });

  it('a true same-signature duplicate gets ~ordinal and the duplicate flag', () => {
    const d0 = fn('twice', { paramTypeList: ['string'], signature: '(a: string)' });
    const d1 = fn('twice', { paramTypeList: ['string'], signature: '(a: string)' });
    const segs = assignSegments([d0, d1]);
    expect(segs[0]!.segment).toBe(`twice#${d0.sigHash}~0`);
    expect(segs[1]!.segment).toBe(`twice#${d1.sigHash}~1`);
    expect(segs.every((s) => s.duplicate)).toBe(true);
  });

  it('illegal duplicate classes (no signature) get name~ordinal + flag', () => {
    const segs = assignSegments([cls('Repeated'), cls('Repeated')]);
    expect(segs.map((s) => s.segment)).toEqual(['Repeated~0', 'Repeated~1']);
    expect(segs.every((s) => s.duplicate)).toBe(true);
  });

  it('overloads and a genuine duplicate can coexist: only the duplicates get ~n', () => {
    const o1 = fn('g', { paramTypeList: ['string'], signature: '(a: string)' });
    const dupA = fn('g', { paramTypeList: ['number'], signature: '(a: number)' });
    const dupB = fn('g', { paramTypeList: ['number'], signature: '(a: number)' });
    const segs = assignSegments([o1, dupA, dupB]);
    expect(segs[0]!.duplicate).toBe(false);
    expect(segs[0]!.segment).toBe(`g#${o1.sigHash}`);
    expect(segs[1]!.duplicate).toBe(true);
    expect(segs[2]!.duplicate).toBe(true);
    expect(new Set(segs.map((s) => s.segment)).size).toBe(3);
  });
});

describe('signatureHash — shape sensitivity', () => {
  it('is stable for the same shape and differs when a param type changes', () => {
    const base = fn('f', { paramTypeList: ['string'], signature: '(a: string)' }).signature!;
    const same = fn('f', { paramTypeList: ['string'], signature: '(a: string)' }).signature!;
    const diff = fn('f', { paramTypeList: ['number'], signature: '(a: number)' }).signature!;
    expect(signatureHash(base)).toBe(signatureHash(same));
    expect(signatureHash(base)).not.toBe(signatureHash(diff));
  });

  it('distinguishes modifiers (async / static / generator / abstract)', () => {
    const plain = fn('m', {}).signature!;
    expect(signatureHash({ ...plain, async: true })).not.toBe(signatureHash(plain));
    expect(signatureHash({ ...plain, static: true })).not.toBe(signatureHash(plain));
    expect(signatureHash({ ...plain, generator: true })).not.toBe(signatureHash(plain));
  });

  it('an absent signature hashes to the empty string', () => {
    expect(signatureHash(undefined)).toBe('');
  });

  it('fnv1a is deterministic and 8 hex chars', () => {
    expect(fnv1a('abc')).toBe(fnv1a('abc'));
    expect(fnv1a('abc')).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a('abc')).not.toBe(fnv1a('abd'));
  });
});
