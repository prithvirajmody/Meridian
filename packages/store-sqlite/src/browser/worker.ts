/**
 * Worker-side half of the browser backend (ADR-0038, amended 11D). The
 * entire `SqliteBackendCore` runs here, over `@sqlite.org/sqlite-wasm`'s
 * synchronous `oo1` API on the OPFS SyncAccessHandle-pool VFS (worker-only,
 * no COOP/COEP requirement). The main thread talks to this API through
 * Comlink; spaces, deltas, and ops cross the boundary via structured clone
 * (plain objects + Maps — the wire shapes are clone-safe by construction).
 *
 * A host app's worker entry is two lines:
 *   import { exposeStorageWorker } from '@meridian/store-sqlite/browser-worker';
 *   exposeStorageWorker();
 */
import * as Comlink from 'comlink';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {
  CURRENT_FORMAT_VERSION,
  MeridianError,
  type GraphId,
  type GraphSpace,
  type SemanticGraph,
} from '@meridian/graph-core';
import type { GraphDelta, GraphManifestEntry, GraphOp, VersionStamp } from '@meridian/graph-store';
import { SqliteBackendCore } from '../core.js';
import {
  initializeSchema,
  integrityFindings,
  isMeridianProject,
  migrateSchema,
  META_SCHEMA_VERSION,
  readMetaValue,
  STORAGE_SCHEMA_VERSION,
} from '../schema.js';
import { SqliteWasmDriver, type Oo1Database } from './driver.js';

const PRODUCER = '@meridian/store-sqlite@0.1.0 (browser)';
const POOL_DIRECTORY = '.meridian-projects';

export interface StorageWorkerOpenOptions {
  /** Project name — becomes the db filename inside the OPFS pool. */
  readonly name: string;
  readonly cold?: boolean;
  readonly checkpointEvery?: number;
  /** Initial space for a project that does not exist yet (import). */
  readonly initialSpace?: GraphSpace;
}

export type StorageWorkerOpenResult =
  | {
      readonly ok: true;
      readonly space: GraphSpace;
      readonly version: VersionStamp;
      readonly replayedDeltas: number;
      readonly manifest?: ReadonlyMap<GraphId, GraphManifestEntry>;
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

interface PoolUtil {
  OpfsSAHPoolDb: new (filename: string) => Oo1Database;
  wipeFiles(): Promise<void>;
  getFileNames(): string[];
  /** Unregisters the VFS and releases its access handles WITHOUT clearing
   * files (`removeVfs` would destroy the data directory). */
  pauseVfs(): unknown;
}

/** The Comlink-exposed surface. One project per worker. */
export interface StorageWorkerApi {
  probe(): Promise<{ ok: boolean; reason?: string }>;
  open(opts: StorageWorkerOpenOptions): Promise<StorageWorkerOpenResult>;
  appendDelta(delta: GraphDelta): Promise<void>;
  persistOps(ops: readonly GraphOp[]): Promise<void>;
  loadGraph(id: GraphId): Promise<SemanticGraph | null>;
  flush(): Promise<void>;
  close(): Promise<void>;
  /** Test/reset hook: wipe every project in this origin's pool. */
  wipeAll(): Promise<void>;
}

function opfsSupported(): { ok: boolean; reason?: string } {
  const nav = (globalThis as { navigator?: { storage?: { getDirectory?: unknown } } }).navigator;
  if (typeof nav?.storage?.getDirectory !== 'function') {
    return { ok: false, reason: 'navigator.storage.getDirectory is unavailable' };
  }
  const fileHandle = (globalThis as { FileSystemFileHandle?: { prototype: object } }).FileSystemFileHandle;
  if (!fileHandle || !('createSyncAccessHandle' in fileHandle.prototype)) {
    return { ok: false, reason: 'FileSystemFileHandle.createSyncAccessHandle is unavailable (no sync access handles in this context)' };
  }
  return { ok: true };
}

export function createStorageWorkerApi(): StorageWorkerApi {
  let poolUtil: PoolUtil | undefined;
  let core: SqliteBackendCore | undefined;

  async function pool(): Promise<PoolUtil> {
    if (poolUtil) return poolUtil;
    const support = opfsSupported();
    if (!support.ok) {
      throw new MeridianError('opfs-unavailable', support.reason ?? 'OPFS unavailable');
    }
    const sqlite3 = await sqlite3InitModule();
    // A predecessor worker's access handles are released asynchronously
    // after its termination, so pool installation retries briefly before
    // concluding the pool is genuinely unavailable.
    let lastError: unknown;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        poolUtil = (await sqlite3.installOpfsSAHPoolVfs({
          directory: POOL_DIRECTORY,
        })) as unknown as PoolUtil;
        return poolUtil;
      } catch (e) {
        lastError = e;
        await new Promise<void>((resolve) => setTimeout(resolve, 150));
      }
    }
    throw new MeridianError(
      'opfs-unavailable',
      `OPFS SyncAccessHandle pool could not be installed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  function requireCore(): SqliteBackendCore {
    if (!core) throw new MeridianError('storage-io', 'no project is open in this worker');
    return core;
  }

  return {
    async probe(): Promise<{ ok: boolean; reason?: string }> {
      try {
        await pool();
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },

    async open(opts: StorageWorkerOpenOptions): Promise<StorageWorkerOpenResult> {
      try {
        const util = await pool();
        const filename = `/${opts.name}`;
        const existed = util.getFileNames().includes(filename);
        const driver = new SqliteWasmDriver(new util.OpfsSAHPoolDb(filename));
        try {
          if (!existed || !isMeridianProject(driver)) {
            if (existed && driver.get("SELECT name FROM sqlite_master WHERE type = 'table' LIMIT 1") !== undefined) {
              throw new MeridianError('storage-not-a-project', `${opts.name} is a SQLite database but not a Meridian project`);
            }
            const space = opts.initialSpace ?? { graphs: new Map(), roots: [] };
            initializeSchema(driver, { formatVersion: CURRENT_FORMAT_VERSION, producer: PRODUCER });
            core = SqliteBackendCore.create(driver, space, opts);
            return { ok: true, space, version: { counter: 0, site: 'local' }, replayedDeltas: 0 };
          }
          const findings = integrityFindings(driver);
          if (findings.length > 0) {
            throw new MeridianError('storage-corrupt', `${opts.name} fails the integrity check (${findings[0]})`);
          }
          if (opts.initialSpace !== undefined) {
            throw new MeridianError('storage-io', `${opts.name} already holds a project — refusing to overwrite it`);
          }
          const stored = Number(readMetaValue(driver, META_SCHEMA_VERSION));
          if (stored !== STORAGE_SCHEMA_VERSION) migrateSchema(driver);
          const opened = SqliteBackendCore.open(driver, opts);
          core = opened.core;
          return { ok: true, ...opened.opened };
        } catch (e) {
          driver.close();
          throw e;
        }
      } catch (e) {
        if (e instanceof MeridianError) return { ok: false, code: e.code, message: e.message };
        throw e;
      }
    },

    async appendDelta(delta: GraphDelta): Promise<void> {
      requireCore().appendDelta(delta);
    },

    async persistOps(ops: readonly GraphOp[]): Promise<void> {
      requireCore().enqueueOps(ops);
    },

    async loadGraph(id: GraphId): Promise<SemanticGraph | null> {
      return requireCore().loadGraphSync(id);
    },

    async flush(): Promise<void> {
      requireCore().flushSync();
    },

    async close(): Promise<void> {
      if (core) {
        core.close();
        core = undefined;
      }
      // Release the pool's access handles deterministically — a successor
      // worker must not have to wait out this worker's garbage collection.
      // pauseVfs, never removeVfs: the latter deletes the data directory.
      if (poolUtil) {
        poolUtil.pauseVfs();
        poolUtil = undefined;
      }
    },

    async wipeAll(): Promise<void> {
      if (core) {
        core.close();
        core = undefined;
      }
      const util = await pool();
      await util.wipeFiles();
      util.pauseVfs();
      poolUtil = undefined;
    },
  };
}

/** Call from the host app's dedicated-worker entry module. */
export function exposeStorageWorker(endpoint: unknown = globalThis): void {
  Comlink.expose(createStorageWorkerApi(), endpoint as Parameters<typeof Comlink.expose>[1]);
}
