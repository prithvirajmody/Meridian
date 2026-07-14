/**
 * `extractStructure` / `StructureExtractor` (8E): text → a *validated* graph
 * proposal. The gateway enforces the schema shape (one repair, then reject);
 * the service adds referential integrity (drop edges to ids no node declares)
 * and stamps provenance. Budget/degradable failures yield an empty, valid
 * proposal (ADR-0032); a replay miss propagates.
 */
import type { MockCompletionHandler } from '@meridian/ai';
import { describe, expect, it } from 'vitest';
import { createStructureExtractor, extractStructure } from '../src/extract.js';
import { makeSession } from './helpers.js';

const hints = { domain: 'arg' };

function structure(value: unknown): MockCompletionHandler {
  return () => ({ kind: 'json', value });
}

describe('extractStructure — happy path', () => {
  it('returns a validated proposal with stamped provenance', async () => {
    const { session } = makeSession({
      onComplete: structure({
        nodes: [
          { id: 'arg:a', kind: 'arg:claim', label: 'A' },
          { id: 'arg:b', kind: 'arg:claim', label: 'B' },
        ],
        edges: [{ id: 'e', src: 'arg:a', dst: 'arg:b', kind: 'arg:supports' }],
      }),
    });
    const result = await extractStructure(session, 'A supports B.', hints);

    expect(result.extracted).toBe(true);
    expect(result.droppedEdges).toBe(0);
    expect(result.proposal.nodes).toHaveLength(2);
    expect(result.proposal.edges).toHaveLength(1);
    expect(result.proposal.provenance).toEqual({
      providerId: 'mock',
      model: 'test-model',
      promptVersion: '1',
      inputHash: expect.any(String),
    });
  });
});

describe('extractStructure — validation the schema can’t express', () => {
  it('drops edges that reference an id no emitted node declares', async () => {
    const { session } = makeSession({
      onComplete: structure({
        nodes: [{ id: 'arg:a', kind: 'arg:claim', label: 'A' }],
        edges: [
          { id: 'e1', src: 'arg:a', dst: 'arg:a', kind: 'arg:supports' },
          { id: 'e2', src: 'arg:a', dst: 'arg:ghost', kind: 'arg:supports' },
        ],
      }),
    });
    const result = await extractStructure(session, 'text', hints);
    expect(result.droppedEdges).toBe(1);
    expect(result.proposal.edges.map((e) => e.id)).toEqual(['e1']);
  });

  it('drops duplicate node ids (first occurrence wins)', async () => {
    const { session } = makeSession({
      onComplete: structure({
        nodes: [
          { id: 'arg:a', kind: 'arg:claim', label: 'first' },
          { id: 'arg:a', kind: 'arg:claim', label: 'dup' },
        ],
        edges: [],
      }),
    });
    const result = await extractStructure(session, 'text', hints);
    expect(result.proposal.nodes).toHaveLength(1);
    expect(result.proposal.nodes[0]!.label).toBe('first');
  });
});

describe('extractStructure — partial/budget/error semantics (ADR-0032)', () => {
  it('short-circuits whitespace-only text to an empty proposal with no call', async () => {
    const { session, completion } = makeSession({ onComplete: structure({ nodes: [], edges: [] }) });
    const result = await extractStructure(session, '   \n\t ', hints);
    expect(result.extracted).toBe(false);
    expect(result.proposal).toEqual({ nodes: [], edges: [] });
    expect(completion.completionCount).toBe(0);
  });

  it('degrades a malformed (schema-invalid) response to an empty proposal', async () => {
    const { session } = makeSession({ onComplete: structure({ nodes: [{ id: 'x', kind: 'nope' }], edges: [] }) });
    const result = await extractStructure(session, 'text', hints);
    expect(result.extracted).toBe(false);
    expect(result.proposal).toEqual({ nodes: [], edges: [] });
    expect(result.stoppedByBudget).toBe(false);
  });

  it('degrades to empty and flags the budget stop when the guard trips', async () => {
    // Spend the budget on a first extraction, then trip on the second.
    const { session } = makeSession({
      onComplete: structure({ nodes: [], edges: [] }),
      budget: { maxTokens: 20 },
    });
    await extractStructure(session, 'first', hints);
    const result = await extractStructure(session, 'second', hints);
    expect(result.extracted).toBe(false);
    expect(result.stoppedByBudget).toBe(true);
    expect(result.budget.tripped).toBe(true);
  });

  it('propagates a replay miss', async () => {
    const { session } = makeSession({ mode: 'replay' });
    await expect(extractStructure(session, 'text', hints)).rejects.toMatchObject({ kind: 'replay_miss' });
  });
});

describe('createStructureExtractor', () => {
  it('exposes the seam and returns just the validated proposal', async () => {
    const { session } = makeSession({
      onComplete: structure({ nodes: [{ id: 'arg:a', kind: 'arg:claim', label: 'A' }], edges: [] }),
    });
    const extractor = createStructureExtractor(session);
    const proposal = await extractor.extract('A.', hints);
    expect(proposal.nodes).toHaveLength(1);
    expect(proposal.provenance?.providerId).toBe('mock');
  });
});
