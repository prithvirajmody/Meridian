/**
 * U8 vocabulary enforcement (Phase 2): with a registry, the semantic pass is
 * an IR gate — unregistered namespaces/keys/kinds and type mismatches are
 * errors. Without one, Phase 0 behavior is unchanged (warnings).
 */
import { describe, expect, it } from 'vitest';
import {
  addGraph,
  addNode,
  asGraphId,
  asNodeId,
  attrValueMatchesType,
  createGraphSpace,
  decode,
  validate,
  type AttrBag,
  type GraphSpace,
  type VocabularyRegistry,
} from '../src/index.js';
import { SRC } from './helpers.js';

const vocabulary: VocabularyRegistry = {
  attrs: new Map([
    ['ext:level', 'number'],
    ['ext:tags', 'string-array'],
    ['ext:flag', 'boolean'],
  ]),
  kinds: new Set(['ext:thing', 'ext:relates-to']),
};

function spaceWith(attrs: AttrBag, kind = 'ext:thing'): GraphSpace {
  let s = createGraphSpace();
  s = addGraph(s, { id: asGraphId('g1'), label: 'G', domain: 'ext', provenance: SRC });
  s = addNode(s, asGraphId('g1'), {
    id: asNodeId('n1'),
    kind,
    label: 'n',
    attrs,
    provenance: SRC,
  });
  return s;
}

describe('validate with a vocabulary registry (U8)', () => {
  it('accepts declared keys with matching types and declared kinds', () => {
    const r = validate(spaceWith({ 'ext:level': 3, 'ext:tags': ['a', 'b'] }), { vocabulary });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('rejects an unregistered namespace as an error, not a warning', () => {
    const r = validate(spaceWith({ 'other:x': 1 }), { vocabulary });
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain('unregistered-namespace');
  });

  it('rejects an undeclared key inside a registered namespace', () => {
    const r = validate(spaceWith({ 'ext:unheard-of': 1 }), { vocabulary });
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain('unregistered-attr-key');
  });

  it('rejects a declared key whose value has the wrong type', () => {
    const r = validate(spaceWith({ 'ext:level': 'three' }), { vocabulary });
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain('attr-type-mismatch');
  });

  it('rejects an unregistered kind; core kinds stay allowed', () => {
    const bad = validate(spaceWith({}, 'other:thing'), { vocabulary });
    expect(bad.errors.map((e) => e.code)).toContain('unregistered-kind');
    const core = validate(spaceWith({}, 'core:cluster'), { vocabulary });
    expect(core.errors).toEqual([]);
  });

  it('without a vocabulary, unregistered namespaces remain warnings (Phase 0/1 behavior)', () => {
    const r = validate(spaceWith({ 'other:x': 1 }));
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.code)).toContain('unregistered-namespace');
  });

  it('decode threads the vocabulary through to the semantic pass', () => {
    const doc = {
      formatVersion: 1,
      producer: { name: 't', version: '0' },
      roots: ['g1'],
      graphs: [
        {
          id: 'g1',
          meta: { label: '', domain: 'ext', provenance: { origin: 'source' } },
          nodes: [
            {
              id: 'n1',
              kind: 'ext:thing',
              label: '',
              attrs: { 'ext:level': 'not-a-number' },
              provenance: { origin: 'source' },
            },
          ],
          edges: [],
        },
      ],
    };
    const rejected = decode(doc, { vocabulary });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.errors.map((e) => e.code)).toContain('attr-type-mismatch');
    }
    expect(decode(doc).ok).toBe(true);
  });
});

describe('attrValueMatchesType', () => {
  it('classifies scalars, arrays, null, and the empty array', () => {
    expect(attrValueMatchesType('x', 'string')).toBe(true);
    expect(attrValueMatchesType(1, 'number')).toBe(true);
    expect(attrValueMatchesType(true, 'boolean')).toBe(true);
    expect(attrValueMatchesType(null, 'null')).toBe(true);
    expect(attrValueMatchesType(null, 'string')).toBe(false);
    expect(attrValueMatchesType(['a'], 'string-array')).toBe(true);
    expect(attrValueMatchesType(['a'], 'number-array')).toBe(false);
    expect(attrValueMatchesType(['a'], 'string')).toBe(false);
    expect(attrValueMatchesType([], 'string-array')).toBe(true);
    expect(attrValueMatchesType([], 'boolean-array')).toBe(true);
    expect(attrValueMatchesType([1, 2], 'number-array')).toBe(true);
  });
});
