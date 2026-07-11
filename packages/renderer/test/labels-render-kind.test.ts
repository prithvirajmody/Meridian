import { describe, expect, it } from 'vitest';
import {
  coverageFromCodePoints,
  coverageFromRanges,
  labelRenderKind,
} from '../src/labels/render-kind.js';
import { meridianAtlasCoverage } from '../src/labels/atlas-manifest.js';

const atlas = meridianAtlasCoverage();

describe('ADR-0020 labelRenderKind routing', () => {
  it('routes ASCII to the bitmap fast path', () => {
    expect(labelRenderKind('hello world 123', atlas)).toBe('bitmap');
    expect(labelRenderKind('README.md', atlas)).toBe('bitmap');
  });

  it('routes Latin-1 and covered punctuation to bitmap', () => {
    expect(labelRenderKind('café résumé', atlas)).toBe('bitmap');
    expect(labelRenderKind('a — b', atlas)).toBe('bitmap');
    expect(labelRenderKind('truncated…', atlas)).toBe('bitmap');
  });

  it('routes Arabic (shaping-required) to the fallback', () => {
    expect(labelRenderKind('مرحبا', atlas)).toBe('fallback');
  });

  it('routes CJK outside the manifest to the fallback', () => {
    expect(labelRenderKind('你好世界', atlas)).toBe('fallback');
  });

  it('routes emoji ZWJ sequences to the fallback', () => {
    expect(labelRenderKind('\u{1F468}‍\u{1F469}‍\u{1F467}', atlas)).toBe('fallback');
  });

  it('routes a single non-BMP emoji to the fallback', () => {
    expect(labelRenderKind('done \u{1F600}', atlas)).toBe('fallback');
  });

  it('honors an explicit coverage set', () => {
    const coverage = coverageFromCodePoints([0x41, 0x42, 0x43]);
    expect(labelRenderKind('ABC', coverage)).toBe('bitmap');
    expect(labelRenderKind('ABCD', coverage)).toBe('fallback');
  });

  it('honors range coverage', () => {
    const coverage = coverageFromRanges([[0x30, 0x39]]);
    expect(labelRenderKind('2026', coverage)).toBe('bitmap');
    expect(labelRenderKind('20a', coverage)).toBe('fallback');
  });
});
