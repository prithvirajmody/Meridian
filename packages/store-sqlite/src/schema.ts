/**
 * Storage schema v1 (ADR-0038 §4) and its migration machinery. The storage
 * schema version is an axis independent of the IR `formatVersion`
 * (ARCHITECTURE §15.3); both use chained single-step migrations (ADR-0004
 * discipline). No wall-clock timestamps anywhere — determinism stays easy.
 */
import { MeridianError } from '@meridian/graph-core';
import type { SqlDriver } from './driver.js';

export const STORAGE_SCHEMA_VERSION = 1;

/** meta keys (one row each). */
export const META_SCHEMA_VERSION = 'schema_version';
export const META_FORMAT_VERSION = 'format_version';
export const META_PRODUCER = 'producer';
export const META_CHECKPOINT_SEQ = 'checkpoint_seq';
export const META_LAST_COUNTER = 'last_counter';

const DDL_V1 = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS graphs (
  id         TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  domain     TEXT NOT NULL,
  provenance TEXT NOT NULL,
  node_count INTEGER NOT NULL DEFAULT 0,
  edge_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS nodes (
  id           TEXT PRIMARY KEY,
  graph_id     TEXT NOT NULL REFERENCES graphs(id),
  kind         TEXT NOT NULL,
  label        TEXT NOT NULL,
  detail_graph TEXT,
  attrs        TEXT,
  provenance   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS edges (
  id         TEXT PRIMARY KEY,
  graph_id   TEXT NOT NULL REFERENCES graphs(id),
  src        TEXT NOT NULL,
  dst        TEXT NOT NULL,
  kind       TEXT NOT NULL,
  weight     REAL,
  attrs      TEXT,
  provenance TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oplog (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  counter INTEGER NOT NULL,
  site    TEXT NOT NULL,
  actor   TEXT NOT NULL,
  ops     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_graph ON nodes(graph_id);
CREATE INDEX IF NOT EXISTS idx_edges_graph ON edges(graph_id);
CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);
`;

/** Single-step storage migration (any→current chains are forbidden). */
export interface StorageMigration {
  readonly from: number;
  readonly to: number;
  up(db: SqlDriver): void;
}

/** Empty at v1; every future schema change lands here as one step. */
export const STORAGE_MIGRATIONS: readonly StorageMigration[] = [];

export function readMetaValue(db: SqlDriver, key: string): string | undefined {
  const row = db.get('SELECT value FROM meta WHERE key = ?', [key]);
  return row === undefined ? undefined : String(row.value);
}

export function writeMetaValue(db: SqlDriver, key: string, value: string): void {
  db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
    key,
    value,
  ]);
}

/** Does this database contain a Meridian project at all? */
export function isMeridianProject(db: SqlDriver): boolean {
  const row = db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'");
  if (row === undefined) return false;
  return readMetaValue(db, META_SCHEMA_VERSION) !== undefined;
}

/** Create the v1 schema in an empty database. */
export function initializeSchema(db: SqlDriver, opts: { formatVersion: number; producer: string }): void {
  db.transaction(() => {
    db.exec(DDL_V1);
    writeMetaValue(db, META_SCHEMA_VERSION, String(STORAGE_SCHEMA_VERSION));
    writeMetaValue(db, META_FORMAT_VERSION, String(opts.formatVersion));
    writeMetaValue(db, META_PRODUCER, opts.producer);
    writeMetaValue(db, META_CHECKPOINT_SEQ, '0');
    writeMetaValue(db, META_LAST_COUNTER, '0');
  });
}

/**
 * Integrity gate (ADR-0038 §6): `PRAGMA quick_check` findings, empty when
 * healthy. A driver may throw `storage-corrupt` before this even runs (a
 * file that is not SQLite at all).
 */
export function integrityFindings(db: SqlDriver): string[] {
  const rows = db.all('PRAGMA quick_check');
  const findings: string[] = [];
  for (const row of rows) {
    const value = Object.values(row)[0];
    if (String(value) !== 'ok') findings.push(String(value));
  }
  return findings;
}

/**
 * Run the chained single-step migrations from the stored version up to
 * current. The caller is responsible for the pre-migration backup (it needs
 * file access the driver does not have). Refuses schemas newer than
 * supported — no best-effort on formats we do not understand (ADR-0004).
 */
export function migrateSchema(
  db: SqlDriver,
  migrations: readonly StorageMigration[] = STORAGE_MIGRATIONS,
  targetVersion: number = STORAGE_SCHEMA_VERSION,
): { readonly from: number; readonly to: number } {
  const raw = readMetaValue(db, META_SCHEMA_VERSION);
  const from = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isInteger(from) || from < 1) {
    throw new MeridianError('storage-corrupt', `meta.schema_version is ${JSON.stringify(raw)} — not a valid storage schema version`);
  }
  if (from > targetVersion) {
    throw new MeridianError(
      'storage-schema-unsupported',
      `project uses storage schema v${from}, this build supports up to v${targetVersion} — refusing (open with a newer Meridian, or export there and import here)`,
    );
  }
  let at = from;
  while (at < targetVersion) {
    const step = migrations.find((m) => m.from === at);
    if (!step) {
      throw new MeridianError('storage-migration-failed', `no migration step from storage schema v${at} — chain is broken`);
    }
    db.transaction(() => {
      step.up(db);
      writeMetaValue(db, META_SCHEMA_VERSION, String(step.to));
    });
    at = step.to;
  }
  return { from, to: at };
}
