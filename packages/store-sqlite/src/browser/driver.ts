/**
 * Browser binding of the `SqlDriver` seam (ADR-0038, amended 11D): the
 * official `@sqlite.org/sqlite-wasm` `oo1` API, which is fully synchronous
 * inside a dedicated worker over the OPFS SyncAccessHandle pool VFS — so
 * both runtimes run the identical `SqliteBackendCore`. This module is
 * worker-side only; the main thread talks to it through the Comlink facade
 * in `worker.ts` and never imports the WASM binding.
 */
import { MeridianError } from '@meridian/graph-core';
import type { SqlDriver, SqlRow, SqlValue } from '../driver.js';

/** The slice of the oo1 `DB` surface the driver uses (typed locally so the
 * heavyweight binding types stay out of the shared core). */
export interface Oo1Database {
  exec(opts: { sql: string; bind?: readonly unknown[] }): unknown;
  exec(sql: string): unknown;
  selectObjects(sql: string, bind?: readonly unknown[]): Record<string, unknown>[];
  close(): void;
}

const RESULT_CODE_BUSY = 5;
const RESULT_CODE_CORRUPT = 11;
const RESULT_CODE_FULL = 13;
const RESULT_CODE_NOTADB = 26;

function mapError(e: unknown): never {
  const code = (e as { resultCode?: number }).resultCode;
  const message = e instanceof Error ? e.message : String(e);
  if (code === RESULT_CODE_BUSY) {
    throw new MeridianError('storage-busy', `database is locked by another writer — Meridian projects are single-writer (ADR-0038): ${message}`);
  }
  if (code === RESULT_CODE_CORRUPT || code === RESULT_CODE_NOTADB) {
    throw new MeridianError('storage-corrupt', `database is corrupted or not SQLite: ${message}`);
  }
  if (code === RESULT_CODE_FULL) {
    throw new MeridianError('storage-io', `I/O failure (storage quota exhausted?): ${message}`);
  }
  throw e;
}

export class SqliteWasmDriver implements SqlDriver {
  private inTransaction = false;

  constructor(private readonly db: Oo1Database) {}

  exec(sql: string): void {
    try {
      this.db.exec(sql);
    } catch (e) {
      mapError(e);
    }
  }

  run(sql: string, params: readonly SqlValue[] = []): void {
    try {
      if (params.length > 0) this.db.exec({ sql, bind: params });
      else this.db.exec(sql);
    } catch (e) {
      mapError(e);
    }
  }

  all(sql: string, params: readonly SqlValue[] = []): SqlRow[] {
    try {
      return this.db.selectObjects(sql, params.length > 0 ? params : undefined) as SqlRow[];
    } catch (e) {
      mapError(e);
    }
  }

  get(sql: string, params: readonly SqlValue[] = []): SqlRow | undefined {
    return this.all(sql, params)[0];
  }

  transaction<T>(fn: () => T): T {
    if (this.inTransaction) {
      throw new MeridianError('storage-io', 'nested SQL transactions are a programming error');
    }
    this.inTransaction = true;
    this.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.exec('COMMIT');
      return result;
    } catch (e) {
      try {
        this.exec('ROLLBACK');
      } catch {
        // the original failure is the interesting one
      }
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
