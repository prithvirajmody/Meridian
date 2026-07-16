/** Backend CRUD + migration machinery (SUBPHASES 11B; ADR-0038 §4/§6). */
import { describe, expect, it } from 'vitest';
import { CURRENT_FORMAT_VERSION, MeridianError } from '@meridian/graph-core';
import {
  initializeSchema,
  integrityFindings,
  isMeridianProject,
  META_FORMAT_VERSION,
  META_SCHEMA_VERSION,
  migrateSchema,
  readMetaValue,
  STORAGE_SCHEMA_VERSION,
  writeMetaValue,
  type StorageMigration,
} from '../src/index.js';
import { BetterSqlite3Driver } from '../src/node/index.js';
import { tmpProjectPath } from './helpers.js';

function freshDb(): BetterSqlite3Driver {
  return new BetterSqlite3Driver(tmpProjectPath());
}

describe('schema initialization', () => {
  it('creates a recognizable v1 project with meta values', () => {
    const db = freshDb();
    expect(isMeridianProject(db)).toBe(false);
    initializeSchema(db, { formatVersion: CURRENT_FORMAT_VERSION, producer: 'test' });
    expect(isMeridianProject(db)).toBe(true);
    expect(readMetaValue(db, META_SCHEMA_VERSION)).toBe(String(STORAGE_SCHEMA_VERSION));
    expect(readMetaValue(db, META_FORMAT_VERSION)).toBe(String(CURRENT_FORMAT_VERSION));
    expect(integrityFindings(db)).toEqual([]);
    db.close();
  });

  it('meta upsert overwrites', () => {
    const db = freshDb();
    initializeSchema(db, { formatVersion: 1, producer: 'test' });
    writeMetaValue(db, 'k', 'a');
    writeMetaValue(db, 'k', 'b');
    expect(readMetaValue(db, 'k')).toBe('b');
    db.close();
  });
});

describe('storage migrations (chained single-step, ADR-0004 discipline)', () => {
  it('a current-version project migrates to itself (no-op)', () => {
    const db = freshDb();
    initializeSchema(db, { formatVersion: 1, producer: 'test' });
    expect(migrateSchema(db)).toEqual({ from: STORAGE_SCHEMA_VERSION, to: STORAGE_SCHEMA_VERSION });
    db.close();
  });

  it('runs the chain step by step and records each version', () => {
    const db = freshDb();
    initializeSchema(db, { formatVersion: 1, producer: 'test' });
    const applied: string[] = [];
    const chain: StorageMigration[] = [
      { from: 1, to: 2, up: (d) => { d.exec('CREATE TABLE m2 (x INTEGER)'); applied.push('1→2'); } },
      { from: 2, to: 3, up: (d) => { d.exec('CREATE TABLE m3 (x INTEGER)'); applied.push('2→3'); } },
    ];
    expect(migrateSchema(db, chain, 3)).toEqual({ from: 1, to: 3 });
    expect(applied).toEqual(['1→2', '2→3']);
    expect(readMetaValue(db, META_SCHEMA_VERSION)).toBe('3');
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'm3'")).toBeDefined();
    db.close();
  });

  it('a broken chain refuses with storage-migration-failed', () => {
    const db = freshDb();
    initializeSchema(db, { formatVersion: 1, producer: 'test' });
    const gapped: StorageMigration[] = [{ from: 2, to: 3, up: () => {} }];
    expect(() => migrateSchema(db, gapped, 3)).toThrowError(MeridianError);
    try {
      migrateSchema(db, gapped, 3);
    } catch (e) {
      expect((e as MeridianError).code).toBe('storage-migration-failed');
    }
    db.close();
  });

  it('a newer schema than supported refuses with storage-schema-unsupported', () => {
    const db = freshDb();
    initializeSchema(db, { formatVersion: 1, producer: 'test' });
    writeMetaValue(db, META_SCHEMA_VERSION, '99');
    try {
      migrateSchema(db);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as MeridianError).code).toBe('storage-schema-unsupported');
    }
    db.close();
  });

  it('a failing migration step rolls back atomically', () => {
    const db = freshDb();
    initializeSchema(db, { formatVersion: 1, producer: 'test' });
    const exploding: StorageMigration[] = [
      {
        from: 1,
        to: 2,
        up: (d) => {
          d.exec('CREATE TABLE half_done (x INTEGER)');
          throw new Error('boom');
        },
      },
    ];
    expect(() => migrateSchema(db, exploding, 2)).toThrowError();
    // The step's transaction rolled back: version unchanged, table absent.
    expect(readMetaValue(db, META_SCHEMA_VERSION)).toBe('1');
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'half_done'")).toBeUndefined();
    db.close();
  });
});
