/** Phase-11 bounded streaming: private staging, backpressure, and publication safety. */
import { asGraphId, createGraphSpace, type GraphMeta } from '@meridian/graph-core';
import { describe, expect, it } from 'vitest';
import {
  stageDeltaStream,
  type ChangeSet,
  type GraphDelta,
  type GraphDeltaInput,
  type StorageBackend,
} from '../src/index.js';

const META: GraphMeta = {
  label: 'streamed',
  domain: 'stream',
  provenance: { origin: 'source' },
};

function addGraphs(from: number, count: number): GraphDeltaInput {
  return {
    origin: { actor: 'test:stream' },
    ops: Array.from({ length: count }, (_, offset) => ({
      t: 'graph:add' as const,
      graph: asGraphId(`g-${from + offset}`),
      meta: { ...META, label: `graph ${from + offset}` },
    })),
  };
}

function recordingBackend(failAppendAt?: number) {
  const appended: GraphDelta[] = [];
  const persisted: ChangeSet[] = [];
  let appendAttempts = 0;
  const backend: StorageBackend = {
    loadGraph: () => Promise.resolve(null),
    appendOps: async (delta) => {
      appendAttempts += 1;
      if (appendAttempts === failAppendAt) throw new Error('disk full');
      appended.push(delta);
    },
    persist: async (change) => {
      persisted.push(change);
    },
    evictHint: () => undefined,
  };
  return { backend, appended, persisted, appendAttempts: () => appendAttempts };
}

describe('stageDeltaStream', () => {
  it('bounds copied batches, awaits storage, reports peak buffering, and preserves the staged store', async () => {
    const storage = recordingBackend();
    const progress: number[] = [];
    let settleCalls = 0;
    const result = await stageDeltaStream(createGraphSpace(), [addGraphs(0, 7)], {
      maxOpsPerBatch: 3,
      backend: storage.backend,
      initialVersion: { counter: 7, site: 'disk' },
      settle: async () => {
        settleCalls += 1;
      },
      onProgress: async (p) => {
        progress.push(p.appliedOps);
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(storage.appended.map((delta) => delta.ops.length)).toEqual([3, 3, 1]);
    expect(storage.persisted.map((change) => change.ops.length)).toEqual([3, 3, 1]);
    expect(settleCalls).toBe(3);
    expect(progress).toEqual([3, 6, 7]);
    expect(result.stats).toEqual({
      emissions: 1,
      inputOps: 7,
      batches: 3,
      appliedOps: 7,
      settledBatches: 3,
      storageSettles: 3,
      peakBufferedOps: 3,
    });
    expect(result.store.version()).toEqual({ counter: 10, site: 'disk' });
    expect(result.space).toBe(result.store.snapshot());
    expect(result.space.graphs.size).toBe(7);

    // The success value is the same backend-attached store, ready for the
    // caller to publish; staging did not flatten it to a bare snapshot.
    expect(result.store.apply(addGraphs(99, 1)).ok).toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(storage.appended.map((delta) => delta.ops.length)).toEqual([3, 3, 1, 1]);
  });

  it('keeps baseVersion on only the first chunk of an envelope', async () => {
    const delta = addGraphs(0, 3);
    const result = await stageDeltaStream(
      createGraphSpace(),
      [{ ...delta, baseVersion: { counter: 4, site: 'seed' } }],
      { maxOpsPerBatch: 1, initialVersion: { counter: 4, site: 'seed' } },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.store.version()).toEqual({ counter: 7, site: 'seed' });
  });

  it('returns an apply failure without exposing the partially staged store', async () => {
    const storage = recordingBackend();
    const duplicate = asGraphId('g-2');
    const result = await stageDeltaStream(
      createGraphSpace(),
      [
        {
          origin: { actor: 'test:invalid' },
          ops: [
            ...addGraphs(0, 3).ops,
            { t: 'graph:add', graph: duplicate, meta: META },
          ],
        },
      ],
      { maxOpsPerBatch: 2, backend: storage.backend },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('apply-failed');
    expect(result.failure.errors?.[0]?.code).toBe('duplicate-id');
    expect(result.stats).toMatchObject({ batches: 1, appliedOps: 2, peakBufferedOps: 2 });
    expect(storage.appended).toHaveLength(1);
    expect('store' in result).toBe(false);
    expect('space' in result).toBe(false);
  });

  it('turns a disk-full backend rejection into a value and stops pulling batches', async () => {
    const storage = recordingBackend(2);
    const backendErrors: unknown[] = [];
    const result = await stageDeltaStream(createGraphSpace(), [addGraphs(0, 6)], {
      maxOpsPerBatch: 2,
      backend: storage.backend,
      onBackendError: (error) => backendErrors.push(error),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toMatchObject({ code: 'storage-failed', emissionIndex: 0, opOffset: 2 });
    expect(result.failure.message).toContain('disk full');
    expect(result.stats).toMatchObject({ batches: 2, appliedOps: 4, settledBatches: 1 });
    expect(storage.appendAttempts()).toBe(2);
    expect(storage.appended).toHaveLength(1);
    expect(storage.persisted).toHaveLength(1);
    expect(backendErrors).toHaveLength(1);
    expect('store' in result).toBe(false);
  });

  it('withholds staging on parser/source throws, settle failures, and interruption', async () => {
    async function* throwingSource(): AsyncGenerator<GraphDeltaInput> {
      yield addGraphs(0, 1);
      throw new Error('parser exploded');
    }
    const sourceFailure = await stageDeltaStream(createGraphSpace(), throwingSource());
    expect(sourceFailure.ok).toBe(false);
    if (!sourceFailure.ok) {
      expect(sourceFailure.failure.code).toBe('source-failed');
      expect(sourceFailure.failure.message).toContain('parser exploded');
      expect('store' in sourceFailure).toBe(false);
    }

    const settleFailure = await stageDeltaStream(createGraphSpace(), [addGraphs(0, 1)], {
      settle: () => {
        throw new Error('checkpoint failed');
      },
    });
    expect(settleFailure.ok).toBe(false);
    if (!settleFailure.ok) expect(settleFailure.failure.code).toBe('storage-failed');

    const controller = new AbortController();
    const interrupted = await stageDeltaStream(createGraphSpace(), [addGraphs(0, 3)], {
      maxOpsPerBatch: 1,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    expect(interrupted.ok).toBe(false);
    if (!interrupted.ok) {
      expect(interrupted.failure.code).toBe('aborted');
      expect(interrupted.stats.appliedOps).toBe(1);
      expect('store' in interrupted).toBe(false);
    }
  });

  it('rejects invalid batching options as a result before consuming the source', async () => {
    let pulled = false;
    const source = {
      *[Symbol.iterator](): Generator<GraphDeltaInput> {
        pulled = true;
        yield addGraphs(0, 1);
      },
    };
    const result = await stageDeltaStream(createGraphSpace(), source, { maxOpsPerBatch: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('invalid-options');
    expect(pulled).toBe(false);
  });
});
