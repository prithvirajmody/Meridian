/**
 * Regression (ROADMAP Phase 1 §12): the Phase 0 fixture corpus now also runs
 * through the store — decode → createStore → snapshot round-trips
 * byte-identically, and a mutate/undo cycle restores the original.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decode, encodePretty, type GraphId, type SemanticGraph } from '@meridian/graph-core';
import { describe, expect, it } from 'vitest';
import { createStore, invertDelta } from '../src/index.js';

const validDir = fileURLToPath(new URL('../../../fixtures/valid/', import.meta.url));
const files = readdirSync(validDir).filter((f) => f.endsWith('.meridian.json'));

describe('P0 fixtures through the store', () => {
  it.each(files)('%s: store snapshot round-trips the document', (file) => {
    const r = decode(readFileSync(validDir + file, 'utf8'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const store = createStore(r.space);
    expect(encodePretty(store.snapshot())).toBe(encodePretty(r.space));
  });

  it.each(files)('%s: a mutation and its inverse restore the original', (file) => {
    const r = decode(readFileSync(validDir + file, 'utf8'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const store = createStore(r.space);
    const before = encodePretty(store.snapshot());
    // Pick any graph deterministically and retitle it.
    const graphId = [...store.snapshot().graphs.keys()].sort()[0] as GraphId;
    const graph = store.snapshot().graphs.get(graphId) as SemanticGraph;
    const applied = store.apply({
      origin: { actor: 'regression' },
      ops: [
        {
          t: 'graph:meta',
          graph: graphId,
          next: { ...graph.meta, label: `${graph.meta.label} (edited)` },
        },
      ],
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(encodePretty(store.snapshot())).not.toBe(before);
    const undone = store.apply(invertDelta(applied.delta));
    expect(undone.ok).toBe(true);
    expect(encodePretty(store.snapshot())).toBe(before);
  });
});
