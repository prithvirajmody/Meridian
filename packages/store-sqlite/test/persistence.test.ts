/**
 * The ADR-0038 durability protocol: log-first appends, write-behind
 * checkpointing, tail replay, durable version stamps, volatile filtering,
 * and single-writer busy refusal.
 */
import { describe, expect, it } from 'vitest';
import { MeridianError } from '@meridian/graph-core';
import { createStore } from '@meridian/graph-store';
import {
  initializeSchema,
  META_CHECKPOINT_SEQ,
  readMetaValue,
  SqliteBackendCore,
  SqliteStorageBackend,
} from '../src/index.js';
import { BetterSqlite3Driver, openProject, openProjectStore } from '../src/node/index.js';
import { addGraphDelta, gid, nid, settleTick, tmpProjectPath, twoLevelSpace } from './helpers.js';

describe('log-first with write-behind checkpoint', () => {
  it('appends land per commit; the checkpoint lags until the threshold', async () => {
    const path = tmpProjectPath();
    const { project, store } = await openProjectStore(path, {
      initialSpace: twoLevelSpace(),
      checkpointEvery: 100, // keep the checkpoint far away
    });
    for (let i = 0; i < 3; i++) expect(store.apply(addGraphDelta(i)).ok).toBe(true);
    await settleTick(); // let post-commit notifications land — but no flush

    const inspector = new BetterSqlite3Driver(path, { readonly: true });
    expect(Number(inspector.get('SELECT COUNT(*) AS n FROM oplog')!.n)).toBe(3);
    expect(readMetaValue(inspector, META_CHECKPOINT_SEQ)).toBe('0');
    expect(Number(inspector.get('SELECT COUNT(*) AS n FROM graphs')!.n)).toBe(2); // still the initial checkpoint
    inspector.close();
    await project.close();
  });

  it('the checkpoint advances automatically at checkpointEvery', async () => {
    const path = tmpProjectPath();
    const { project, store } = await openProjectStore(path, {
      initialSpace: twoLevelSpace(),
      checkpointEvery: 2,
    });
    for (let i = 0; i < 4; i++) expect(store.apply(addGraphDelta(i)).ok).toBe(true);
    await settleTick();

    const inspector = new BetterSqlite3Driver(path, { readonly: true });
    expect(readMetaValue(inspector, META_CHECKPOINT_SEQ)).toBe('4');
    expect(Number(inspector.get('SELECT COUNT(*) AS n FROM graphs')!.n)).toBe(6);
    inspector.close();
    await project.close();
  });

  it('an abandoned session (no close) recovers by replaying the tail', async () => {
    const path = tmpProjectPath();
    const { store } = await openProjectStore(path, {
      initialSpace: twoLevelSpace(),
      checkpointEvery: 100,
    });
    for (let i = 0; i < 5; i++) expect(store.apply(addGraphDelta(i)).ok).toBe(true);
    await settleTick();
    // No close, no flush — simulate an abandoned session; the log has the
    // commits, the element tables do not.

    const reopened = await openProject(path);
    expect(reopened.replayedDeltas).toBe(5);
    expect(reopened.version).toEqual({ counter: 5, site: 'local' });
    expect(reopened.space.graphs.size).toBe(7);
    await reopened.close();

    // Recovery finished the checkpoint: a third open replays nothing.
    const again = await openProject(path);
    expect(again.replayedDeltas).toBe(0);
    expect(again.space.graphs.size).toBe(7);
    await again.close();
  });
});

describe('durable version stamps (ADR-0007 → P11)', () => {
  it('the counter survives reopen and keeps monotonic across sessions', async () => {
    const path = tmpProjectPath();
    {
      const { project, store } = await openProjectStore(path, { initialSpace: twoLevelSpace() });
      store.apply(addGraphDelta(1));
      store.apply(addGraphDelta(2));
      await project.close();
    }
    {
      const { project, store } = await openProjectStore(path);
      expect(store.version()).toEqual({ counter: 2, site: 'local' });
      const applied = store.apply(addGraphDelta(3));
      expect(applied.ok && applied.delta.baseVersion.counter === 2).toBe(true);
      await project.close();
    }
    const final = await openProject(path);
    expect(final.version.counter).toBe(3);
    await final.close();
  });

  it('volatile commits advance the session but never the durable state', async () => {
    const path = tmpProjectPath();
    const { project, store } = await openProjectStore(path, { initialSpace: twoLevelSpace() });
    expect(store.apply(addGraphDelta(1)).ok).toBe(true);
    expect(store.apply(addGraphDelta(2, 'meridian:hydration', true)).ok).toBe(true);
    expect(store.version().counter).toBe(2);
    await project.close();

    const reopened = await openProject(path);
    expect(reopened.version.counter).toBe(1); // the volatile commit is not history
    expect(reopened.space.graphs.get(gid('g-extra-1'))).toBeDefined();
    expect(reopened.space.graphs.get(gid('g-extra-2'))).toBeUndefined();
    await reopened.close();
  });
});

describe('core reads', () => {
  it('loadGraphSync sees every committed change (flushes its own queue)', async () => {
    const path = tmpProjectPath();
    const { project, store } = await openProjectStore(path, {
      initialSpace: twoLevelSpace(),
      checkpointEvery: 100,
    });
    const applied = store.apply({
      origin: { actor: 'test' },
      ops: [{ t: 'node:attr', graph: gid('g-child'), id: nid('n-c'), key: 'test:mark', next: 'x' }],
    });
    expect(applied.ok).toBe(true);
    await settleTick();

    const graph = project.backend.core.loadGraphSync(gid('g-child'));
    expect(graph).not.toBeNull();
    expect(graph!.nodes.get(nid('n-c'))!.attrs['test:mark']).toBe('x');
    expect(project.backend.core.loadGraphSync(gid('g-absent'))).toBeNull();
    await project.close();
  });

  it('graphSummaries reports maintained element counts', async () => {
    const path = tmpProjectPath();
    const { project, store } = await openProjectStore(path, { initialSpace: twoLevelSpace() });
    store.apply(addGraphDelta(1));
    await settleTick();
    const summaries = project.backend.core.graphSummaries();
    expect(summaries.get(gid('g-root'))).toEqual({ nodeCount: 2, edgeCount: 1 });
    expect(summaries.get(gid('g-child'))).toEqual({ nodeCount: 1, edgeCount: 0 });
    expect(summaries.get(gid('g-extra-1'))).toEqual({ nodeCount: 0, edgeCount: 0 });
    await project.close();
  });
});

describe('failure containment', () => {
  it('a second writer holding the write lock surfaces as storage-busy', async () => {
    const path = tmpProjectPath();
    const { project } = await openProjectStore(path, { initialSpace: twoLevelSpace() });

    const rival = new BetterSqlite3Driver(path);
    rival.exec('BEGIN IMMEDIATE');
    try {
      expect(() => rival2Write(path)).toThrowError(MeridianError);
      try {
        rival2Write(path);
      } catch (e) {
        expect((e as MeridianError).code).toBe('storage-busy');
      }
    } finally {
      rival.exec('COMMIT');
      rival.close();
    }
    await project.close();

    function rival2Write(p: string): void {
      const w = new BetterSqlite3Driver(p);
      try {
        w.run("INSERT INTO meta (key, value) VALUES ('probe', '1') ON CONFLICT(key) DO UPDATE SET value = '1'");
      } finally {
        w.close();
      }
    }
  });

  it('a backend append failure is contained and reported, session stays valid', async () => {
    const path = tmpProjectPath();
    const errors: unknown[] = [];
    const db = new BetterSqlite3Driver(path);
    initializeSchema(db, { formatVersion: 1, producer: 'test' });
    const core = SqliteBackendCore.create(db, twoLevelSpace());
    const backend = new SqliteStorageBackend(core);
    const store = createStore(twoLevelSpace(), {
      backend,
      onBackendError: (e) => errors.push(e),
    });

    db.close(); // sever durability out from under the backend
    expect(store.apply(addGraphDelta(1)).ok).toBe(true);
    await settleTick();
    expect(errors.length).toBe(1);
    expect(store.apply(addGraphDelta(2)).ok).toBe(true); // session keeps working
    await settleTick();
    expect(errors.length).toBe(2); // dead backend keeps refusing, chain not stalled
    expect(store.snapshot().graphs.size).toBe(4);
  });
});
