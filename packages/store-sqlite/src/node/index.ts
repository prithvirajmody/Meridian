/**
 * Node entrypoint (`@meridian/store-sqlite/node`): open/create/salvage a
 * `.meridian` project file over better-sqlite3 (ADR-0038). The open flow:
 * integrity gate → (backup + migrate) → checkpoint load + oplog tail replay
 * → hand back `{ space, version, backend }` for `createStore`.
 */
import { copyFileSync, existsSync } from 'node:fs';
import {
  createGraphSpace,
  CURRENT_FORMAT_VERSION,
  MeridianError,
  type GraphSpace,
} from '@meridian/graph-core';
import {
  createStore,
  type CreateStoreOptions,
  type GraphStore,
  type VersionStamp,
} from '@meridian/graph-store';
import { SqliteBackendCore, SqliteStorageBackend, type CoreOptions } from '../core.js';
import { initializeSchema, integrityFindings, isMeridianProject, migrateSchema, META_SCHEMA_VERSION, readMetaValue, STORAGE_SCHEMA_VERSION } from '../schema.js';
import { salvageToDocument, type SalvageResult } from '../salvage.js';
import { BetterSqlite3Driver } from './driver.js';

export { BetterSqlite3Driver } from './driver.js';

const PRODUCER = '@meridian/store-sqlite@0.1.0';

export interface OpenProjectOptions extends CoreOptions {
  /**
   * Initial space for a project file that does not exist yet. Refused when
   * the file already holds a project (import into an existing project is a
   * delta, not an overwrite).
   */
  readonly initialSpace?: GraphSpace;
}

export interface MeridianProject {
  readonly path: string;
  /** The materialized space at open (checkpoint + replayed tail). */
  readonly space: GraphSpace;
  /** Durable version seed for `createStore` (ADR-0007's P11 arrival). */
  readonly version: VersionStamp;
  readonly backend: SqliteStorageBackend;
  /** Oplog deltas replayed beyond the checkpoint at open (0 = clean close). */
  readonly replayedDeltas: number;
  /** Storage-schema migration performed at open, if any. */
  readonly migrated?: { readonly from: number; readonly to: number };
  /** Settle pending post-commit notifications and materialize everything. */
  flush(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Open a project file, creating it (empty or from `initialSpace`) when it
 * does not exist. Throws typed `MeridianError`s: `storage-corrupt` (with
 * salvage guidance), `storage-busy`, `storage-schema-unsupported`,
 * `storage-not-a-project`.
 */
export async function openProject(path: string, opts: OpenProjectOptions = {}): Promise<MeridianProject> {
  const preexisting = existsSync(path);
  const db = new BetterSqlite3Driver(path);
  try {
    if (!preexisting || !hasAnyTable(db)) {
      if (preexisting && !isEmptyDatabase(db)) {
        throw new MeridianError('storage-not-a-project', `${path} is a SQLite database but not a Meridian project`);
      }
      const space = opts.initialSpace ?? createGraphSpace();
      initializeSchema(db, { formatVersion: CURRENT_FORMAT_VERSION, producer: PRODUCER });
      const core = SqliteBackendCore.create(db, space, opts);
      return wrap(path, db, core, {
        space,
        version: { counter: 0, site: 'local' },
        replayedDeltas: 0,
      });
    }

    if (!isMeridianProject(db)) {
      throw new MeridianError('storage-not-a-project', `${path} is a SQLite database but not a Meridian project`);
    }
    const findings = integrityFindings(db);
    if (findings.length > 0) {
      throw new MeridianError(
        'storage-corrupt',
        `${path} fails the integrity check (${findings[0]}${findings.length > 1 ? ` — and ${findings.length - 1} more` : ''}) — refusing to open read-write; use salvageProject() / \`meridian open --salvage\` to export what is recoverable`,
      );
    }
    if (opts.initialSpace !== undefined) {
      throw new MeridianError('storage-io', `${path} already holds a project — refusing to overwrite it with an initial space`);
    }

    let migrated: { from: number; to: number } | undefined;
    const storedVersion = Number(readMetaValue(db, META_SCHEMA_VERSION));
    if (storedVersion < STORAGE_SCHEMA_VERSION) {
      copyFileSync(path, `${path}.pre-migrate-v${storedVersion}.bak`);
      migrated = migrateSchema(db);
    } else if (storedVersion > STORAGE_SCHEMA_VERSION) {
      migrateSchema(db); // throws storage-schema-unsupported with the message
    }

    const { core, opened } = SqliteBackendCore.open(db, opts);
    return wrap(path, db, core, opened, migrated);
  } catch (e) {
    db.close();
    throw e;
  }
}

/**
 * Convenience: open the project and stand up the session store wired to its
 * backend — the composition most hosts want.
 */
export async function openProjectStore(
  path: string,
  opts: OpenProjectOptions & Pick<CreateStoreOptions, 'onListenerError' | 'onBackendError'> = {},
): Promise<{ project: MeridianProject; store: GraphStore }> {
  const project = await openProject(path, opts);
  const store = createStore(project.space, {
    backend: project.backend,
    initialVersion: project.version,
    ...(opts.onListenerError ? { onListenerError: opts.onListenerError } : {}),
    ...(opts.onBackendError ? { onBackendError: opts.onBackendError } : {}),
  });
  return { project, store };
}

/** Best-effort export of a damaged project file. Never writes to it. */
export function salvageProject(path: string): SalvageResult {
  if (!existsSync(path)) {
    throw new MeridianError('storage-io', `${path} does not exist`);
  }
  const db = new BetterSqlite3Driver(path, { readonly: true });
  try {
    return salvageToDocument(db, { producer: { name: PRODUCER, version: '0.1.0' } });
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- internals

function hasAnyTable(db: BetterSqlite3Driver): boolean {
  return db.get("SELECT name FROM sqlite_master WHERE type = 'table' LIMIT 1") !== undefined;
}

function isEmptyDatabase(db: BetterSqlite3Driver): boolean {
  return !hasAnyTable(db);
}

function wrap(
  path: string,
  db: BetterSqlite3Driver,
  core: SqliteBackendCore,
  opened: { space: GraphSpace; version: VersionStamp; replayedDeltas: number },
  migrated?: { from: number; to: number },
): MeridianProject {
  const backend = new SqliteStorageBackend(core);
  let closed = false;
  return {
    path,
    space: opened.space,
    version: opened.version,
    backend,
    replayedDeltas: opened.replayedDeltas,
    ...(migrated ? { migrated } : {}),
    async flush(): Promise<void> {
      await backend.settle();
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        await backend.settle();
      } finally {
        core.close();
      }
    },
  };
}
