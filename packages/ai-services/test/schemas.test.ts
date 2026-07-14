/**
 * The structured-output schemas are the last line before AI text becomes graph
 * shape (§8.3): they must accept well-formed output and reject the malformed
 * corners a model can produce (bad namespaces, out-of-range confidence, wrong
 * value types). The gateway runs these; here we pin their shape directly.
 */
import { describe, expect, it } from 'vitest';
import {
  extractedStructureSchema,
  proposedEdgeSchema,
  proposedNodeSchema,
  rollupSummarySchema,
} from '../src/schemas.js';

describe('rollupSummarySchema', () => {
  it('accepts a well-formed name/summary/confidence', () => {
    const r = rollupSummarySchema.safeParse({ name: 'Auth', summary: 'Login code.', confidence: 0.9 });
    expect(r.success).toBe(true);
  });

  it.each([
    ['empty name', { name: '', summary: 's', confidence: 0.5 }],
    ['confidence > 1', { name: 'n', summary: 's', confidence: 1.5 }],
    ['confidence < 0', { name: 'n', summary: 's', confidence: -0.1 }],
    ['missing confidence', { name: 'n', summary: 's' }],
    ['summary too long', { name: 'n', summary: 'x'.repeat(401), confidence: 0.5 }],
  ])('rejects %s', (_label, value) => {
    expect(rollupSummarySchema.safeParse(value).success).toBe(false);
  });
});

describe('proposedNodeSchema', () => {
  it('accepts a namespaced node with scalar attrs', () => {
    const r = proposedNodeSchema.safeParse({
      id: 'arg:n1',
      kind: 'arg:claim',
      label: 'A claim',
      attrs: { 'arg:weight': 3, 'arg:certain': true, 'arg:note': 'x' },
    });
    expect(r.success).toBe(true);
  });

  it.each([
    ['non-namespaced kind', { id: 'n1', kind: 'claim', label: 'x' }],
    ['uppercase in kind', { id: 'n1', kind: 'Arg:Claim', label: 'x' }],
    ['empty id', { id: '', kind: 'arg:claim', label: 'x' }],
    ['non-scalar attr value', { id: 'n1', kind: 'arg:claim', label: 'x', attrs: { 'arg:k': { nested: 1 } } }],
    ['non-namespaced attr key', { id: 'n1', kind: 'arg:claim', label: 'x', attrs: { weight: 3 } }],
  ])('rejects %s', (_label, value) => {
    expect(proposedNodeSchema.safeParse(value).success).toBe(false);
  });
});

describe('proposedEdgeSchema', () => {
  it('accepts a namespaced edge', () => {
    expect(
      proposedEdgeSchema.safeParse({ id: 'e1', src: 'n1', dst: 'n2', kind: 'arg:supports' }).success,
    ).toBe(true);
  });

  it('rejects a non-namespaced edge kind', () => {
    expect(proposedEdgeSchema.safeParse({ id: 'e1', src: 'n1', dst: 'n2', kind: 'supports' }).success).toBe(false);
  });
});

describe('extractedStructureSchema', () => {
  it('accepts nodes + edges together', () => {
    const r = extractedStructureSchema.safeParse({
      nodes: [{ id: 'arg:a', kind: 'arg:claim', label: 'A' }],
      edges: [{ id: 'e', src: 'arg:a', dst: 'arg:a', kind: 'arg:supports' }],
    });
    expect(r.success).toBe(true);
  });

  it('rejects when nodes is missing', () => {
    expect(extractedStructureSchema.safeParse({ edges: [] }).success).toBe(false);
  });

  it('accepts an empty structure', () => {
    expect(extractedStructureSchema.safeParse({ nodes: [], edges: [] }).success).toBe(true);
  });
});
