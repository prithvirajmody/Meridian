import { describe, expect, it } from 'vitest';
import { deriveKeyHash, MemoryResponseStore, type ResponseKey, type StoredResponse } from '../src/store.js';

const key = (over: Partial<ResponseKey> = {}): ResponseKey => ({
  kind: 'completion',
  providerId: 'p',
  model: 'm',
  promptId: 'spec',
  promptVersion: '1',
  inputHash: 'abc',
  attempt: 'primary',
  ...over,
});

describe('deriveKeyHash', () => {
  it('is deterministic and order-independent', () => {
    expect(deriveKeyHash(key())).toBe(deriveKeyHash(key()));
  });

  it('distinguishes the repair attempt from the primary', () => {
    expect(deriveKeyHash(key({ attempt: 'primary' }))).not.toBe(
      deriveKeyHash(key({ attempt: 'repair' })),
    );
  });

  it('distinguishes prompt versions', () => {
    expect(deriveKeyHash(key({ promptVersion: '1' }))).not.toBe(
      deriveKeyHash(key({ promptVersion: '2' })),
    );
  });
});

describe('MemoryResponseStore', () => {
  it('round-trips values and reports size', async () => {
    const store = new MemoryResponseStore();
    expect(await store.get('missing')).toBeUndefined();
    const record: StoredResponse = { meta: key(), value: { hello: 'world' } };
    await store.set('k', record);
    expect(await store.get('k')).toEqual(record);
    expect(store.size).toBe(1);
  });

  it('snapshots and reloads the whole fixture set (record → replay substrate)', async () => {
    const source = new MemoryResponseStore();
    await source.set('k', { meta: key(), value: 42 });
    const snapshot = source.snapshot();

    const replay = new MemoryResponseStore(snapshot);
    expect((await replay.get('k'))?.value).toBe(42);

    const loaded = new MemoryResponseStore();
    loaded.load(snapshot);
    expect((await loaded.get('k'))?.value).toBe(42);
  });
});
