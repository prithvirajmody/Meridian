/**
 * Subscription semantics (ADR-0008): batched per transaction, async
 * microtask delivery, in-order, exactly-once, capture-at-commit, contained
 * listener failures, and the no-re-entrant-mutation rule.
 */
import { describe, expect, it } from 'vitest';
import { createStore, type ChangeSet } from '../src/index.js';
import { demoSpace, gLeaf, gRoot, nB, nD, ORIGIN } from './helpers.js';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function attrOp(i: number) {
  return { t: 'node:attr' as const, graph: gRoot, id: nB, key: 'demo:count', next: i };
}

describe('subscriptions', () => {
  it('delivers one ChangeSet per transaction, asynchronously, in commit order', async () => {
    const store = createStore(demoSpace());
    const seen: ChangeSet[] = [];
    store.subscribe((c) => seen.push(c));
    store.apply({ origin: ORIGIN, ops: [attrOp(1)] });
    store.apply({ origin: ORIGIN, ops: [attrOp(2), { t: 'node:attr', graph: gLeaf, id: nD, key: 'demo:x', next: true }] });
    expect(seen).toHaveLength(0); // async: nothing before the microtask flush
    await flush();
    expect(seen).toHaveLength(2);
    expect(seen[0]!.fromVersion.counter).toBe(0);
    expect(seen[0]!.toVersion.counter).toBe(1);
    expect(seen[0]!.ops).toHaveLength(1);
    expect(seen[1]!.toVersion.counter).toBe(2);
    expect(seen[1]!.ops).toHaveLength(2);
    expect(seen[1]!.origin).toEqual(ORIGIN);
  });

  it('reports touched graphs and nodes, including edge endpoints and detail children', async () => {
    const store = createStore(demoSpace());
    const seen: ChangeSet[] = [];
    store.subscribe((c) => seen.push(c));
    store.apply({ origin: ORIGIN, ops: [{ t: 'node:detail', graph: gRoot, id: nB, next: undefined }] });
    store.apply({ origin: ORIGIN, ops: [{ t: 'edge:remove', graph: gRoot, id: 'e-ab' as never }] });
    await flush();
    // no-op detail clear still touches host graph + node (conservative).
    expect([...seen[0]!.touched.graphs]).toContain(gRoot);
    expect([...seen[0]!.touched.nodes]).toContain(nB);
    // edge removal touches both endpoints.
    expect([...seen[1]!.touched.nodes].sort()).toEqual(['n-a', 'n-b']);
  });

  it('rejected deltas emit nothing', async () => {
    const store = createStore(demoSpace());
    let count = 0;
    store.subscribe(() => count++);
    store.apply({ origin: ORIGIN, ops: [] });
    store.apply({ origin: ORIGIN, ops: [{ t: 'node:remove', graph: gRoot, id: 'n-missing' as never }] });
    await flush();
    expect(count).toBe(0);
  });

  it('captures the listener set at commit time', async () => {
    const store = createStore(demoSpace());
    const early: number[] = [];
    const late: number[] = [];
    const unsubEarly = store.subscribe((c) => early.push(c.toVersion.counter));
    store.apply({ origin: ORIGIN, ops: [attrOp(1)] });
    unsubEarly(); // after commit, before flush: still receives the fact
    store.subscribe((c) => late.push(c.toVersion.counter)); // after commit: never sees it
    await flush();
    expect(early).toEqual([1]);
    expect(late).toEqual([]);
    store.apply({ origin: ORIGIN, ops: [attrOp(2)] });
    await flush();
    expect(early).toEqual([1]); // unsubscribed for good
    expect(late).toEqual([2]);
  });

  it('a throwing listener is contained and routed to onListenerError', async () => {
    const errors: unknown[] = [];
    const store = createStore(demoSpace(), { onListenerError: (e) => errors.push(e) });
    const seen: number[] = [];
    store.subscribe(() => {
      throw new Error('bad listener');
    });
    store.subscribe((c) => seen.push(c.toVersion.counter));
    store.apply({ origin: ORIGIN, ops: [attrOp(1)] });
    await flush();
    store.apply({ origin: ORIGIN, ops: [attrOp(2)] });
    await flush();
    expect(seen).toEqual([1, 2]); // other listeners and later commits unaffected
    expect(errors).toHaveLength(2);
    expect((errors[0] as Error).message).toBe('bad listener');
    expect(store.version().counter).toBe(2); // store not poisoned
  });

  it('re-entrant mutation from a listener throws and does not corrupt the store', async () => {
    const errors: unknown[] = [];
    const store = createStore(demoSpace(), { onListenerError: (e) => errors.push(e) });
    store.subscribe(() => {
      store.apply({ origin: ORIGIN, ops: [attrOp(99)] });
    });
    store.apply({ origin: ORIGIN, ops: [attrOp(1)] });
    await flush();
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toMatch(/reentrant-mutation|re-entrantly/);
    expect(store.version().counter).toBe(1);
    // A listener that *enqueues* instead is legal.
    const store2 = createStore(demoSpace());
    let done = false;
    store2.subscribe((c) => {
      if (c.toVersion.counter === 1) {
        queueMicrotask(() => {
          const r = store2.apply({ origin: { actor: 'enqueued' }, ops: [attrOp(2)] });
          done = r.ok;
        });
      }
    });
    store2.apply({ origin: ORIGIN, ops: [attrOp(1)] });
    await flush();
    expect(done).toBe(true);
    expect(store2.version().counter).toBe(2);
  });
});
