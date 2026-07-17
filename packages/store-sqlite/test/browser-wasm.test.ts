/**
 * Browser-binding tests that can run honestly in Node: the real SQLite WASM
 * binary and oo1 API run against an in-memory database, while the capability
 * result explicitly says that durability requires worker OPFS. Real OPFS
 * reopen durability remains in the shared Playwright parity suite.
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { MeridianError } from '@meridian/graph-core';
import { createStore } from '@meridian/graph-store';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  META_CHECKPOINT_SEQ,
  META_LAST_COUNTER,
  SqliteBackendCore,
  initializeSchema,
  readMetaValue,
  writeMetaValue,
} from '../src/index.js';
import { detectBrowserStorageCapability } from '../src/browser/capability.js';
import { SqliteWasmDriver, type Oo1Database } from '../src/browser/driver.js';
import { openBrowserProject } from '../src/browser/index.js';
import { addGraphDelta, gid, twoLevelSpace } from './helpers.js';

let sqlite3!: Awaited<ReturnType<typeof sqlite3InitModule>>;

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});

function memoryDriver(): SqliteWasmDriver {
  // The package's Node export intentionally supports memory only. The driver
  // is nevertheless the exact oo1 seam used inside the browser worker.
  const raw = new sqlite3.oo1.DB(':memory:');
  return new SqliteWasmDriver(raw as unknown as Oo1Database);
}

describe('located browser persistence capability', () => {
  it('does not call a Node/main-thread WASM load durable', () => {
    const result = detectBrowserStorageCapability({});
    expect(result).toEqual({
      ok: false,
      mode: 'memory',
      durability: 'volatile',
      code: 'opfs-unavailable',
      location: 'navigator.storage.getDirectory',
      reason: 'navigator.storage.getDirectory is unavailable',
    });
  });

  it('locates a missing SyncAccessHandle separately from missing OPFS', () => {
    const result = detectBrowserStorageCapability({
      navigator: { storage: { getDirectory: () => undefined } },
      FileSystemFileHandle: { prototype: {} },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.location).toBe('FileSystemFileHandle.createSyncAccessHandle');
      expect(result.durability).toBe('volatile');
    }
  });

  it('keeps API presence unverified until the worker installs the VFS', () => {
    const result = detectBrowserStorageCapability({
      navigator: { storage: { getDirectory: () => undefined } },
      FileSystemFileHandle: {
        prototype: { createSyncAccessHandle: () => undefined },
      },
    });
    expect(result).toEqual({
      ok: true,
      mode: 'opfs',
      durability: 'unverified',
      location: 'FileSystemFileHandle.createSyncAccessHandle',
    });
  });

  it('exposes a located volatile capability on host-forced fallback', async () => {
    let workerCreated = false;
    const outcome = await openBrowserProject('forced.meridian', {
      forceUnavailable: true,
      workerFactory: () => {
        workerCreated = true;
        throw new Error('worker should not be created');
      },
    });
    expect(workerCreated).toBe(false);
    expect(outcome.mode).toBe('memory');
    expect(outcome.capability).toMatchObject({
      ok: false,
      durability: 'volatile',
      location: 'host-policy',
    });
  });
});

describe('actual SQLite WASM smoke', () => {
  it('runs the shared schema, op-log, checkpoint, and graph read protocol', () => {
    const db = memoryDriver();
    const space = twoLevelSpace();
    initializeSchema(db, { formatVersion: 1, producer: 'wasm-smoke' });
    const core = SqliteBackendCore.create(db, space, { checkpointEvery: 1 });

    const store = createStore(space);
    const applied = store.apply(addGraphDelta(1, 'wasm-smoke'));
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error('smoke delta was rejected');
    core.appendDelta(applied.delta);
    core.enqueueChange(applied.changes);

    expect(readMetaValue(db, META_LAST_COUNTER)).toBe('1');
    expect(readMetaValue(db, META_CHECKPOINT_SEQ)).toBe('1');
    expect(core.loadGraphSync(gid('g-extra-1'))).not.toBeNull();
    core.close();
  });

  it('classifies a structurally impossible checkpoint as corruption', () => {
    const db = memoryDriver();
    initializeSchema(db, { formatVersion: 1, producer: 'wasm-corruption' });
    SqliteBackendCore.create(db, twoLevelSpace());
    writeMetaValue(db, META_CHECKPOINT_SEQ, '1'); // log head is still zero

    try {
      SqliteBackendCore.open(db);
      expect.unreachable('corrupt checkpoint should have been refused');
    } catch (error) {
      expect(error).toBeInstanceOf(MeridianError);
      expect((error as MeridianError).code).toBe('storage-corrupt');
      expect((error as Error).message).toContain('checkpoint_seq');
    } finally {
      db.close();
    }
  });

  it('maps a deterministic SQLite quota exhaustion to located storage-io', () => {
    const db = memoryDriver();
    db.exec('PRAGMA page_size = 512; CREATE TABLE quota_probe (payload BLOB)');
    const pages = Number(db.get('PRAGMA page_count')?.page_count);
    db.exec(`PRAGMA max_page_count = ${pages}`);

    try {
      db.run('INSERT INTO quota_probe(payload) VALUES (zeroblob(?))', [1024 * 1024]);
      expect.unreachable('quota-limited insert should have failed');
    } catch (error) {
      expect(error).toBeInstanceOf(MeridianError);
      expect((error as MeridianError).code).toBe('storage-io');
      expect((error as Error).message).toContain('storage quota exhausted');
    } finally {
      db.close();
    }
  });
});

describe('browser single-writer refusal', () => {
  it('uses BEGIN IMMEDIATE and maps extended BUSY without poisoning the driver', () => {
    const statements: string[] = [];
    let busy = true;
    const raw: Oo1Database = {
      exec(input: string | { sql: string }): unknown {
        const sql = typeof input === 'string' ? input : input.sql;
        statements.push(sql);
        if (sql === 'BEGIN IMMEDIATE' && busy) {
          // SQLITE_BUSY_RECOVERY: extended code, primary low byte = BUSY (5).
          throw Object.assign(new Error('writer held elsewhere'), { resultCode: 5 | (1 << 8) });
        }
        return undefined;
      },
      selectObjects: () => [],
      close: () => undefined,
    };
    const db = new SqliteWasmDriver(raw);

    expect(() => db.transaction(() => undefined)).toThrowError(MeridianError);
    try {
      db.transaction(() => undefined);
    } catch (error) {
      expect((error as MeridianError).code).toBe('storage-busy');
    }
    busy = false;
    expect(db.transaction(() => 'ok')).toBe('ok');
    expect(statements).toContain('BEGIN IMMEDIATE');
    expect(statements).toContain('COMMIT');
  });
});
