/**
 * The narrow synchronous SQL seam both runtime bindings implement
 * (ADR-0038): better-sqlite3 in Node, wa-sqlite (sync build, in a worker)
 * in the browser. Everything above this interface — schema, migrations,
 * the open/append/checkpoint protocol — is written once and shared, which
 * is what makes the 11D parity suite a suite and not two suites.
 */

export type SqlValue = string | number | bigint | Uint8Array | null;
export type SqlRow = Record<string, SqlValue>;

export interface SqlDriver {
  /** Execute multi-statement DDL. */
  exec(sql: string): void;
  /** Execute one statement with bound parameters. */
  run(sql: string, params?: readonly SqlValue[]): void;
  all(sql: string, params?: readonly SqlValue[]): SqlRow[];
  get(sql: string, params?: readonly SqlValue[]): SqlRow | undefined;
  /**
   * Run `fn` inside one SQLite transaction: commit on return, rollback on
   * throw. Nesting is a programming error (drivers may throw).
   */
  transaction<T>(fn: () => T): T;
  close(): void;
}
