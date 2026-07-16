/**
 * StorageBackend notification semantics (ADR-0038, SUBPHASES 11B): post-commit
 * async FIFO delivery (`appendOps` then `persist`), volatile-commit exclusion,
 * per-commit failure containment via `onBackendError`, durable version seeding
 * through `initialVersion`, and AI-provenance round-tripping over the delta
 * wire form (ADR-0031 quartet).
 */
import { asGraphId, asNodeId, MeridianError, type SemanticNode, type SourceRef } from '@meridian/graph-core';
import { describe, expect, it } from 'vitest';
import {
  createStore,
  decodeDelta,
  deltaToWire,
  type ChangeSet,
  type GraphDelta,
  type StorageBackend,
  type VersionStamp,
} from '../src/index.js';
import { demoSpace, gRoot, nB, ORIGIN, SRC } from './helpers.js';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function attrOp(i: number) {
  return { t: 'node:attr' as const, graph: gRoot, id: nB, key: 'demo:count', next: i };
}

type BackendCall =
  | { readonly kind: 'appendOps'; readonly delta: GraphDelta }
  | { readonly kind: 'persist'; readonly change: ChangeSet };

/** A recording backend; `rejectAppendOnce` makes the next appendOps reject. */
function recordingBackend() {
  const calls: BackendCall[] = [];
  const state = { rejectAppendOnce: undefined as Error | undefined };
  const backend: StorageBackend = {
    loadGraph: () => Promise.resolve(null),
    appendOps: (delta) => {
      if (state.rejectAppendOnce) {
        const e = state.rejectAppendOnce;
        state.rejectAppendOnce = undefined;
        return Promise.reject(e);
      }
      calls.push({ kind: 'appendOps', delta });
      return Promise.resolve();
    },
    persist: (change) => {
      calls.push({ kind: 'persist', change });
      return Promise.resolve();
    },
    evictHint: () => {},
  };
  return { backend, calls, state };
}

describe('backend notification', () => {
  it('receives appendOps then persist with the committed delta and ChangeSet', async () => {
    const { backend, calls } = recordingBackend();
    const store = createStore(demoSpace(), { backend });
    const result = store.apply({ origin: ORIGIN, ops: [attrOp(1)] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await flush();
    expect(calls.map((c) => c.kind)).toEqual(['appendOps', 'persist']);
    expect(calls[0]).toMatchObject({ kind: 'appendOps' });
    expect((calls[0] as { delta: GraphDelta }).delta).toEqual(result.delta);
    expect((calls[1] as { change: ChangeSet }).change).toEqual(result.changes);
  });

  it('receives nothing after a rejected apply', async () => {
    const { backend, calls } = recordingBackend();
    const store = createStore(demoSpace(), { backend });
    const result = store.apply({
      origin: ORIGIN,
      ops: [{ t: 'node:remove', graph: gRoot, id: asNodeId('n-missing') }],
    });
    expect(result.ok).toBe(false);
    await flush();
    expect(calls).toHaveLength(0);
  });

  it('delivers rapid commits FIFO, in commit order, with correct baseVersions', async () => {
    const { backend, calls } = recordingBackend();
    const store = createStore(demoSpace(), { backend });
    store.apply({ origin: ORIGIN, ops: [attrOp(1)] });
    store.apply({ origin: ORIGIN, ops: [attrOp(2)] });
    store.apply({ origin: ORIGIN, ops: [attrOp(3)] });
    await flush();
    expect(calls.map((c) => c.kind)).toEqual([
      'appendOps',
      'persist',
      'appendOps',
      'persist',
      'appendOps',
      'persist',
    ]);
    const deltas = calls.filter((c): c is Extract<BackendCall, { kind: 'appendOps' }> => c.kind === 'appendOps');
    expect(deltas.map((c) => c.delta.baseVersion.counter)).toEqual([0, 1, 2]);
    expect(deltas.map((c) => c.delta.ops[0])).toMatchObject([
      { next: 1 },
      { next: 2 },
      { next: 3 },
    ]);
    const changes = calls.filter((c): c is Extract<BackendCall, { kind: 'persist' }> => c.kind === 'persist');
    expect(changes.map((c) => c.change.toVersion.counter)).toEqual([1, 2, 3]);
  });

  it('apply returns before the backend is called (async, off the write path)', async () => {
    const { backend, calls } = recordingBackend();
    const store = createStore(demoSpace(), { backend });
    const result = store.apply({ origin: ORIGIN, ops: [attrOp(1)] });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(0); // nothing synchronous
    await flush();
    expect(calls.map((c) => c.kind)).toEqual(['appendOps', 'persist']);
  });

  it('volatile commits advance the version and notify subscribers but never the backend', async () => {
    const { backend, calls } = recordingBackend();
    const store = createStore(demoSpace(), { backend });
    const seen: ChangeSet[] = [];
    store.subscribe((c) => seen.push(c));
    const result = store.apply({ origin: { actor: 'x', volatile: true }, ops: [attrOp(1)] });
    expect(result.ok).toBe(true);
    expect(store.version().counter).toBe(1);
    await flush();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.toVersion.counter).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it('contains an appendOps rejection: onBackendError fires, persist is skipped, the chain continues', async () => {
    const errors: unknown[] = [];
    const { backend, calls, state } = recordingBackend();
    const store = createStore(demoSpace(), { backend, onBackendError: (e) => errors.push(e) });
    const boom = new Error('disk on fire');
    state.rejectAppendOnce = boom;
    const first = store.apply({ origin: ORIGIN, ops: [attrOp(1)] });
    expect(first.ok).toBe(true);
    await flush();
    expect(errors).toEqual([boom]);
    expect(calls).toHaveLength(0); // persist skipped for the failed commit
    // The store keeps working and the NEXT commit still notifies the backend.
    const second = store.apply({ origin: ORIGIN, ops: [attrOp(2)] });
    expect(second.ok).toBe(true);
    expect(store.version().counter).toBe(2);
    await flush();
    expect(calls.map((c) => c.kind)).toEqual(['appendOps', 'persist']);
    expect((calls[0] as { delta: GraphDelta }).delta.baseVersion.counter).toBe(1);
    expect(errors).toHaveLength(1); // no new errors
  });

  it('a throwing onBackendError hook does not break later commits', async () => {
    const { backend, calls, state } = recordingBackend();
    const store = createStore(demoSpace(), {
      backend,
      onBackendError: () => {
        throw new Error('the error hook is itself broken');
      },
    });
    state.rejectAppendOnce = new Error('backend down');
    store.apply({ origin: ORIGIN, ops: [attrOp(1)] });
    await flush();
    expect(calls).toHaveLength(0);
    store.apply({ origin: ORIGIN, ops: [attrOp(2)] });
    await flush();
    expect(calls.map((c) => c.kind)).toEqual(['appendOps', 'persist']);
    expect((calls[0] as { delta: GraphDelta }).delta.ops[0]).toMatchObject({ next: 2 });
  });
});

describe('initialVersion seeding (ADR-0007 durability, delivered by ADR-0038)', () => {
  it('seeds version() and stamps the next commit from it', () => {
    const store = createStore(demoSpace(), { initialVersion: { counter: 41, site: 'local' } });
    expect(store.version()).toEqual({ counter: 41, site: 'local' });
    const result = store.apply({ origin: ORIGIN, ops: [attrOp(1)] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(store.version()).toEqual({ counter: 42, site: 'local' });
    expect(result.delta.baseVersion).toEqual({ counter: 41, site: 'local' });
  });

  it.each([
    ['negative counter', { counter: -1, site: 'local' }],
    ['non-integer counter', { counter: 1.5, site: 'local' }],
    ['empty site', { counter: 3, site: '' }],
  ] as const)('rejects a malformed initialVersion (%s) with invalid-version', (_name, bad) => {
    let thrown: unknown;
    try {
      createStore(demoSpace(), { initialVersion: bad as VersionStamp });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(MeridianError);
    expect((thrown as MeridianError).code).toBe('invalid-version');
  });
});

describe('delta wire round-trip (ADR-0031 AI-provenance quartet)', () => {
  it('preserves providerId, model, promptVersion, inputHash, confidence through JSON', () => {
    const provenance: SourceRef = {
      origin: 'ai',
      uri: 'ai://enrich/run-7',
      providerId: 'anthropic',
      model: 'claude-test-1',
      promptVersion: 'enrich-v3',
      inputHash: 'sha256:abc123',
      confidence: 0.75,
    };
    const node: SemanticNode = {
      id: asNodeId('n-ai'),
      kind: 'demo:step',
      label: 'proposed by ai',
      attrs: {},
      provenance,
    };
    const store = createStore(demoSpace());
    const result = store.apply({ origin: { actor: 'ai:enrich' }, ops: [{ t: 'node:add', graph: gRoot, node }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const wire = JSON.parse(JSON.stringify(deltaToWire(result.delta))) as unknown;
    const decoded = decodeDelta(wire);
    expect(decoded.ok, !decoded.ok ? JSON.stringify(decoded.errors) : '').toBe(true);
    if (!decoded.ok) return;
    const op = decoded.delta.ops[0]!;
    expect(op.t).toBe('node:add');
    if (op.t !== 'node:add') return;
    expect(op.node.provenance).toEqual(provenance);
    expect(op.node).toEqual(node);
  });

  it('non-AI provenance still round-trips unchanged (control)', () => {
    const store = createStore(demoSpace());
    const node: SemanticNode = {
      id: asNodeId('n-src'),
      kind: 'demo:step',
      label: 'from source',
      attrs: {},
      provenance: SRC,
    };
    const result = store.apply({ origin: ORIGIN, ops: [{ t: 'node:add', graph: asGraphId('g-root'), node }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const decoded = decodeDelta(JSON.parse(JSON.stringify(deltaToWire(result.delta))));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.delta.ops[0]).toMatchObject({ t: 'node:add', node: { provenance: SRC } });
  });
});
