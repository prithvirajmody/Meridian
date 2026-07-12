/**
 * URL state codec (ADR-0025): exact round-trip of the full navigation value,
 * `ov` truncation at `URL_MAX` with a diagnostic, id escaping, and located
 * (never-thrown) errors for malformed fragments.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { asGraphId, asNodeId } from '@meridian/graph-core';
import { decodeNavUrl, encodeNavUrl, type NavUrlState } from '../src/url.js';
import { URL_MAX } from '../src/constants.js';

const base: NavUrlState = {
  g: asGraphId('g-root'),
  ctx: [asNodeId('A'), asNodeId('a1')],
  z: 0.4237,
  cam: { cx: -12.5, cy: 88.25, s: 3.5 },
  focus: asNodeId('a1'),
  ov: [
    { node: asNodeId('x'), kind: 'expand' },
    { node: asNodeId('y'), kind: 'collapse' },
    { node: asNodeId('z'), kind: 'pin' },
  ],
};

describe('URL codec round-trip (ADR-0025 / ROADMAP §11)', () => {
  it('encode → decode restores the exact value', () => {
    const { fragment, truncated } = encodeNavUrl(base);
    expect(truncated).toBe(false);
    expect(fragment.startsWith('#g=')).toBe(true);
    const decoded = decodeNavUrl(fragment);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.state).toEqual(base);
  });

  it('round-trips z and camera bit-for-bit (String/Number)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ noNaN: true, noDefaultInfinity: true }),
        fc.double({ noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 1e-6, max: 1e6, noNaN: true }),
        (z, cx, cy, s) => {
          const state: NavUrlState = { g: asGraphId('g'), ctx: [], z, cam: { cx, cy, s }, ov: [] };
          const decoded = decodeNavUrl(encodeNavUrl(state).fragment);
          expect(decoded.ok).toBe(true);
          if (decoded.ok) {
            // `===` (not `Object.is`) so `-0` and `+0` compare equal: `String`
            // maps `-0 → "0"`, and a signed zero is the same coordinate.
            expect(decoded.state.z === z).toBe(true);
            expect(decoded.state.cam.cx === cx).toBe(true);
            expect(decoded.state.cam.cy === cy).toBe(true);
            expect(decoded.state.cam.s === s).toBe(true);
          }
        },
      ),
    );
  });

  it('percent-encodes ids that contain delimiters (code-domain paths)', () => {
    const state: NavUrlState = {
      g: asGraphId('src/app.ts#g'),
      ctx: [asNodeId('src/app.ts::Foo,Bar')],
      z: 0.5,
      cam: { cx: 0, cy: 0, s: 1 },
      ov: [{ node: asNodeId('a:b&c'), kind: 'pin' }],
    };
    const decoded = decodeNavUrl(encodeNavUrl(state).fragment);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.state).toEqual(state);
  });

  it('omits optional fields when empty (focus, ov, ctx)', () => {
    const minimal: NavUrlState = { g: asGraphId('g'), ctx: [], z: 0, cam: { cx: 0, cy: 0, s: 1 }, ov: [] };
    const { fragment } = encodeNavUrl(minimal);
    expect(fragment).not.toContain('focus=');
    expect(fragment).not.toContain('ov=');
    expect(fragment).not.toContain('ctx=');
    const decoded = decodeNavUrl(fragment);
    expect(decoded.ok && decoded.state).toEqual(minimal);
  });
});

describe('ov truncation at URL_MAX (ADR-0025)', () => {
  it('drops ov entries from the tail with a reported diagnostic, keeping the link valid', () => {
    // Long node ids so a big override map blows past URL_MAX.
    const ov = Array.from({ length: 400 }, (_, i) => ({
      node: asNodeId(`node-with-a-fairly-long-identifier-${i}`),
      kind: 'expand' as const,
    }));
    const state: NavUrlState = { g: asGraphId('g'), ctx: [], z: 0.5, cam: { cx: 1, cy: 2, s: 3 }, ov };
    const result = encodeNavUrl(state);
    expect(result.truncated).toBe(true);
    expect(result.droppedOverrides).toBeGreaterThan(0);
    expect(result.fragment.length).toBeLessThanOrEqual(URL_MAX);
    // The non-ov state still decodes cleanly.
    const decoded = decodeNavUrl(result.fragment);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.state.z).toBe(0.5);
      expect(decoded.state.cam).toEqual({ cx: 1, cy: 2, s: 3 });
      expect(decoded.state.ov.length).toBe(ov.length - result.droppedOverrides);
    }
  });
});

describe('malformed fragments → located errors, never throw (ADR-0025)', () => {
  it('reports missing required fields', () => {
    const decoded = decodeNavUrl('#z=0.5');
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.errors.some((e) => e.startsWith('g:'))).toBe(true);
      expect(decoded.errors.some((e) => e.startsWith('cam:'))).toBe(true);
    }
  });

  it('reports a malformed camera tuple', () => {
    const decoded = decodeNavUrl('#g=x&z=0.5&cam=1,2');
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.errors.some((e) => e.startsWith('cam:'))).toBe(true);
  });

  it('reports a bad override code and a non-finite z', () => {
    const decoded = decodeNavUrl('#g=x&z=abc&cam=0,0,1&ov=n:q');
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.errors.some((e) => e.startsWith('z:'))).toBe(true);
      expect(decoded.errors.some((e) => e.startsWith('ov:'))).toBe(true);
    }
  });

  it('never throws on arbitrary junk', () => {
    for (const junk of ['', '#', '###', '&&&', 'g', '#=&=&', '#g=%ZZ&z=0&cam=0,0,1']) {
      expect(() => decodeNavUrl(junk)).not.toThrow();
    }
  });
});
