/**
 * better-sqlite3 binding of the `SqlDriver` seam (Node only — this module
 * and its sibling are the sole importers of the native binding, §20). WAL
 * mode; `synchronous = NORMAL` is crash-safe against process death (the
 * kill -9 contract) — commits live in the OS page cache, not the process.
 */
import { MeridianError } from '@meridian/graph-core';
import Database from 'better-sqlite3';
import type { SqlDriver, SqlRow, SqlValue } from '../driver.js';

function mapError(e: unknown): never {
  const code = (e as { code?: string }).code ?? '';
  const message = e instanceof Error ? e.message : String(e);
  if (code.startsWith('SQLITE_BUSY') || code === 'SQLITE_LOCKED') {
    throw new MeridianError('storage-busy', `database is locked by another writer — Meridian projects are single-writer (ADR-0038): ${message}`);
  }
  if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB') {
    throw new MeridianError('storage-corrupt', `database is corrupted or not SQLite: ${message}`);
  }
  if (code === 'SQLITE_FULL' || code === 'SQLITE_IOERR' || code.startsWith('SQLITE_IOERR')) {
    throw new MeridianError('storage-io', `I/O failure (disk full?): ${message}`);
  }
  throw e;
}

export class BetterSqlite3Driver implements SqlDriver {
  private readonly db: Database.Database;
  private inTransaction = false;

  constructor(path: string, opts: { readonly?: boolean } = {}) {
    try {
      this.db = new Database(path, { readonly: opts.readonly ?? false });
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('busy_timeout = 200');
      this.db.pragma('foreign_keys = OFF'); // ops inside one delta may order freely; the store already guarantees integrity
    } catch (e) {
      mapError(e);
    }
  }

  exec(sql: string): void {
    try {
      this.db.exec(sql);
    } catch (e) {
      mapError(e);
    }
  }

  run(sql: string, params: readonly SqlValue[] = []): void {
    try {
      this.db.prepare(sql).run(...params);
    } catch (e) {
      mapError(e);
    }
  }

  all(sql: string, params: readonly SqlValue[] = []): SqlRow[] {
    try {
      return this.db.prepare(sql).all(...params) as SqlRow[];
    } catch (e) {
      mapError(e);
    }
  }

  get(sql: string, params: readonly SqlValue[] = []): SqlRow | undefined {
    try {
      return this.db.prepare(sql).get(...params) as SqlRow | undefined;
    } catch (e) {
      mapError(e);
    }
  }

  transaction<T>(fn: () => T): T {
    if (this.inTransaction) {
      throw new MeridianError('storage-io', 'nested SQL transactions are a programming error');
    }
    this.inTransaction = true;
    try {
      return this.db.transaction(fn)();
    } catch (e) {
      if (e instanceof MeridianError) throw e;
      mapError(e);
    } finally {
      this.inTransaction = false;
    }
  }

  close(): void {
    this.db.close();
  }
}
