import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import type { LodResult, NodeId } from '@meridian/view-model';
import type { ChangeSet } from '@meridian/graph-store';
import {
  BatchCoalescer,
  diffAffectedCut,
  diffLayoutResults,
} from '../src/pipeline/incremental.js';
import { isPresentationOnlyChange } from '../src/navigation/studio-navigator.js';

function lod(ids: readonly string[]): LodResult {
  return {
    cut: {
      level: 0,
      members: ids as NodeId[],
      trace: new Map(),
      coverage: { leaves: ids.length, coveredLeaves: ids.length, covers: true },
    },
    inducedEdges: [],
    trace: new Map(),
    frontier: { expandable: [], needsHydration: [] },
    ignoredOverrides: [],
    budget: { requested: ids.length, applied: false, collapses: [] },
  } as unknown as LodResult;
}

describe('Phase 11 incremental pipeline values', () => {
  it('never treats cut-driving salience or recency attributes as presentation-only', () => {
    const change = (key: string): ChangeSet => ({
      fromVersion: { counter: 0, site: 'local' },
      toVersion: { counter: 1, site: 'local' },
      origin: { actor: 'test' },
      ops: [{ t: 'node:attr', graph: 'g' as never, id: 'n' as NodeId, key, next: 1 }],
      touched: { graphs: new Set(['g' as never]), nodes: new Set(['n' as NodeId]) },
    });
    expect(isPresentationOnlyChange(change('test:color'))).toBe(true);
    expect(isPresentationOnlyChange(change('core:salience'))).toBe(false);
    expect(isPresentationOnlyChange(change('core:updated-at'))).toBe(false);
  });

  it('diffs cut membership and exact recomputed retained members', () => {
    expect(diffAffectedCut(lod(['a', 'b']), lod(['b', 'c']), ['a', 'b', 'z'] as NodeId[])).toEqual({
      added: ['c'],
      removed: ['a'],
      retained: ['b'],
      affected: ['b'],
    });
  });

  it('diffs layout positions and routes without losing the full next fallback', () => {
    const before = {
      positions: new Map([["a" as NodeId, { x: 0, y: 0, width: 1, height: 1 }]]),
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      stability: 1,
    };
    const after = {
      positions: new Map([
        ["a" as NodeId, { x: 2, y: 0, width: 1, height: 1 }],
        ["b" as NodeId, { x: 4, y: 0, width: 1, height: 1 }],
      ]),
      bounds: { x: 2, y: 0, width: 3, height: 1 },
      stability: 0.9,
    };
    const patch = diffLayoutResults(before, after);
    expect(patch.next).toBe(after);
    expect(patch.added).toEqual(['b']);
    expect(patch.changed).toEqual(['a']);
    expect(patch.boundsChanged).toBe(true);
  });
});

describe('BatchCoalescer', () => {
  it('coalesces 100 synchronous edits into one ordered batch', () => {
    const callbacks: (() => void)[] = [];
    const batches: readonly number[][] = [];
    const mutable = batches as number[][];
    const coalescer = new BatchCoalescer<number>((batch) => { mutable.push([...batch]); }, {
      schedule: (callback) => (callbacks.push(callback), callback),
      cancel: () => undefined,
    });
    for (let index = 0; index < 100; index++) coalescer.enqueue(index);
    callbacks[0]!();
    expect(batches).toEqual([Array.from({ length: 100 }, (_, index) => index)]);
  });

  it('delivers arbitrary storms exactly once, in order, with bounded pending memory', () => {
    fc.assert(
      fc.property(fc.array(fc.integer(), { minLength: 1, maxLength: 300 }), (events) => {
        const delivered: number[] = [];
        const coalescer = new BatchCoalescer<number>((batch) => { delivered.push(...batch); }, {
          maxPending: 17,
          schedule: () => 1,
          cancel: () => undefined,
        });
        for (const event of events) {
          coalescer.enqueue(event);
          expect(coalescer.size).toBeLessThan(17);
        }
        coalescer.flush();
        expect(delivered).toEqual(events);
      }),
      { numRuns: 60 },
    );
  });

  it('serializes async consumers and drains the newest batch after the active one settles', async () => {
    const callbacks: (() => void)[] = [];
    const batches: number[][] = [];
    const releases: (() => void)[] = [];
    let active = 0;
    let maxActive = 0;
    const coalescer = new BatchCoalescer<number>(
      async (batch) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        batches.push([...batch]);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
      },
      { schedule: (callback) => (callbacks.push(callback), callback), cancel: () => undefined },
    );

    coalescer.enqueue(1);
    callbacks.shift()!();
    coalescer.enqueue(2);
    coalescer.enqueue(3);
    callbacks.shift()!();
    expect(batches).toEqual([[1]]);
    expect(maxActive).toBe(1);

    releases.shift()!();
    await vi.waitFor(() => expect(batches).toEqual([[1], [2, 3]]));
    expect(maxActive).toBe(1);
    releases.shift()!();
  });

  it('reports an async consumer rejection and continues with pending work', async () => {
    const callbacks: (() => void)[] = [];
    const batches: number[][] = [];
    const errors: unknown[] = [];
    let rejectFirst!: (error: unknown) => void;
    const coalescer = new BatchCoalescer<number>(
      (batch) => {
        batches.push([...batch]);
        if (batches.length === 1) return new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
      },
      {
        schedule: (callback) => (callbacks.push(callback), callback),
        cancel: () => undefined,
        onError: (error) => errors.push(error),
      },
    );

    coalescer.enqueue(1);
    callbacks.shift()!();
    coalescer.enqueue(2);
    callbacks.shift()!();
    rejectFirst(new Error('layout failed'));
    await vi.waitFor(() => expect(batches).toEqual([[1], [2]]));
    expect(errors).toHaveLength(1);
  });

  it('uses caller compaction to keep async pending state below the hard limit', () => {
    let release!: () => void;
    const coalescer = new BatchCoalescer<number>(
      () => new Promise<void>((resolve) => { release = resolve; }),
      { maxPending: 4, schedule: () => 1, compact: (pending) => pending.at(-1)! },
    );
    coalescer.enqueue(0);
    coalescer.flush();
    for (let value = 1; value <= 100; value++) {
      coalescer.enqueue(value);
      expect(coalescer.size).toBeLessThan(4);
    }
    release();
  });
});
