/**
 * Main-thread half of the browser backend (`@meridian/store-sqlite/browser`,
 * ADR-0038 amended 11D). Spawns the host-provided storage worker, probes
 * OPFS, and fronts the worker with a `StorageBackend`. OPFS unavailable is
 * a *mode*, not an error: the caller gets `{ mode: 'memory' }` and runs the
 * fully-supported in-memory + document-export session (persistence is an
 * enhancement, never a correctness requirement — ADR-0038 §7).
 *
 * This module never imports the WASM binding — that lives in the worker.
 */
import * as Comlink from 'comlink';
import type { GraphId, GraphSpace, SemanticGraph } from '@meridian/graph-core';
import {
  createStore,
  HydrationManager,
  type ChangeSet,
  type CreateStoreOptions,
  type GraphDelta,
  type GraphManifestEntry,
  type GraphStore,
  type HydrationPolicy,
  type StorageBackend,
  type VersionStamp,
} from '@meridian/graph-store';
import type { StorageWorkerApi } from './worker.js';
import {
  volatileBrowserStorage,
  type BrowserStorageCapability,
  type DurableBrowserStorageCapability,
  type VolatileBrowserStorageCapability,
} from './capability.js';

export { detectBrowserStorageCapability } from './capability.js';
export type {
  BrowserStorageCapability,
  BrowserStorageCapabilityLocation,
  BrowserStoragePrerequisiteResult,
  BrowserStoragePrerequisitesPresent,
  DurableBrowserStorageCapability,
  VolatileBrowserStorageCapability,
} from './capability.js';

export interface BrowserProjectOptions {
  /** Host-provided worker factory (the app owns bundling, ADR-0017 style):
   * `() => new Worker(new URL('./storage-worker-entry.ts', import.meta.url), { type: 'module' })` */
  readonly workerFactory: () => Worker;
  readonly cold?: boolean;
  readonly checkpointEvery?: number;
  readonly initialSpace?: GraphSpace;
  /** Test hook: behave as if OPFS were unavailable (exercises the fallback). */
  readonly forceUnavailable?: boolean;
  /** Test hook: wipe the origin's project pool before opening. */
  readonly wipeFirst?: boolean;
}

export interface BrowserMeridianProject {
  readonly name: string;
  readonly space: GraphSpace;
  readonly version: VersionStamp;
  readonly replayedDeltas: number;
  readonly manifest?: ReadonlyMap<GraphId, GraphManifestEntry>;
  readonly backend: StorageBackend;
  flush(): Promise<void>;
  close(): Promise<void>;
  /** Simulate an unclean end (kill the worker without flushing). */
  abandon(): Promise<void>;
}

export type BrowserOpenOutcome =
  | {
      readonly mode: 'opfs';
      readonly capability: DurableBrowserStorageCapability;
      readonly project: BrowserMeridianProject;
    }
  | {
      readonly mode: 'memory';
      readonly capability: VolatileBrowserStorageCapability;
      readonly reason: string;
    };

class WorkerStorageBackend implements StorageBackend {
  /** Tail of all work this backend has been handed. Unlike the Node binding,
   * every call is a real async round trip, so "everything has landed" is a
   * convergence question — see `settle`. */
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly api: Comlink.Remote<StorageWorkerApi>) {}

  private track<T>(work: Promise<T>): Promise<T> {
    this.tail = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }

  loadGraph(id: GraphId): Promise<SemanticGraph | null> {
    return this.track(this.api.loadGraph(id));
  }

  persist(change: ChangeSet): Promise<void> {
    // Only the op list crosses the wire; the worker's core materializes from
    // ops exactly as the Node path materializes from ChangeSets.
    return this.track(this.api.persistOps(change.ops));
  }

  appendOps(delta: GraphDelta): Promise<void> {
    return this.track(this.api.appendDelta(delta));
  }

  evictHint(_ids: readonly GraphId[]): void {
    // Advisory; the browser backend has nothing to drop (ADR-0038).
  }

  /**
   * Wait until the store's post-commit notification chain has fully drained
   * into the worker. The store enqueues commit N+1's `appendOps` only after
   * commit N's `persist` resolves, so awaiting the current tail plus a tick
   * repeatedly converges exactly when no further work was enqueued.
   */
  async settle(): Promise<void> {
    for (;;) {
      const seen = this.tail;
      await seen;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (seen === this.tail) return;
    }
  }
}

export async function openBrowserProject(
  name: string,
  opts: BrowserProjectOptions,
): Promise<BrowserOpenOutcome> {
  if (opts.forceUnavailable === true) {
    const capability = volatileBrowserStorage(
      'host-policy',
      'OPFS unavailable (forced by host)',
    );
    return { mode: 'memory', capability, reason: capability.reason };
  }
  const worker = opts.workerFactory();
  const api = Comlink.wrap<StorageWorkerApi>(worker);
  const fail = async (
    capability: VolatileBrowserStorageCapability,
  ): Promise<BrowserOpenOutcome> => {
    worker.terminate();
    return { mode: 'memory', capability, reason: capability.reason };
  };
  try {
    const probe = await api.probe();
    if (!probe.ok) return await fail(probe);
    if (opts.wipeFirst === true) await api.wipeAll();
    const opened = await api.open({
      name,
      ...(opts.cold !== undefined ? { cold: opts.cold } : {}),
      ...(opts.checkpointEvery !== undefined ? { checkpointEvery: opts.checkpointEvery } : {}),
      ...(opts.initialSpace !== undefined ? { initialSpace: opts.initialSpace } : {}),
    });
    if (!opened.ok) {
      // Corruption/schema refusals are real errors, not fallback: silent data
      // divergence must never masquerade as a fresh session.
      if (opened.code === 'opfs-unavailable') {
        return await fail(volatileBrowserStorage('opfs-sah-pool', opened.message));
      }
      worker.terminate();
      throw Object.assign(new Error(opened.message), { code: opened.code, name: 'MeridianError' });
    }
    const backend = new WorkerStorageBackend(api);
    let closed = false;
    const settle = async (): Promise<void> => {
      await backend.settle();
      await api.flush();
    };
    return {
      mode: 'opfs',
      capability: probe,
      project: {
        name,
        space: opened.space,
        version: opened.version,
        replayedDeltas: opened.replayedDeltas,
        ...(opened.manifest ? { manifest: opened.manifest } : {}),
        backend,
        flush: settle,
        async close(): Promise<void> {
          if (closed) return;
          closed = true;
          await settle();
          await api.close();
          worker.terminate();
        },
        async abandon(): Promise<void> {
          if (closed) return;
          closed = true;
          // Let the appends land (they are durability), skip the checkpoint
          // (that is exactly what an unclean end loses), then kill the worker.
          await backend.settle();
          worker.terminate();
        },
      },
    };
  } catch (e) {
    if ((e as { name?: string }).name === 'MeridianError') throw e;
    return await fail(
      volatileBrowserStorage(
        'storage-worker',
        `storage worker failed: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }
}

/** Wipe every project in this origin's OPFS pool (test/reset hook). */
export async function wipeBrowserProjects(
  workerFactory: () => Worker,
): Promise<{ ok: boolean; reason?: string }> {
  const worker = workerFactory();
  const api = Comlink.wrap<StorageWorkerApi>(worker);
  try {
    const probe = await api.probe();
    if (!probe.ok) return { ok: false, ...(probe.reason !== undefined ? { reason: probe.reason } : {}) };
    await api.wipeAll();
    return { ok: true };
  } finally {
    worker.terminate();
  }
}

export interface BrowserSession {
  readonly mode: 'opfs' | 'memory';
  readonly capability: BrowserStorageCapability;
  readonly reason?: string;
  readonly store: GraphStore;
  readonly project?: BrowserMeridianProject;
  readonly hydration?: HydrationManager;
}

/** Convenience composition: open (or fall back) and stand up the session
 * store — memory mode yields a working store with no backend. */
export async function openBrowserProjectStore(
  name: string,
  opts: BrowserProjectOptions &
    Pick<CreateStoreOptions, 'onListenerError' | 'onBackendError'> & {
      readonly hydrationPolicy?: HydrationPolicy;
    },
): Promise<BrowserSession> {
  const outcome = await openBrowserProject(name, opts);
  if (outcome.mode === 'memory') {
    const store = createStore(opts.initialSpace ?? { graphs: new Map(), roots: [] }, {
      ...(opts.onListenerError ? { onListenerError: opts.onListenerError } : {}),
    });
    return {
      mode: 'memory',
      capability: outcome.capability,
      reason: outcome.reason,
      store,
    };
  }
  const { project } = outcome;
  const store = createStore(project.space, {
    backend: project.backend,
    initialVersion: project.version,
    ...(opts.onListenerError ? { onListenerError: opts.onListenerError } : {}),
    ...(opts.onBackendError ? { onBackendError: opts.onBackendError } : {}),
  });
  if (project.manifest === undefined) {
    return { mode: 'opfs', capability: outcome.capability, store, project };
  }
  const hydration = new HydrationManager({
    store,
    backend: project.backend,
    manifest: project.manifest,
    ...(opts.hydrationPolicy ? { policy: opts.hydrationPolicy } : {}),
  });
  return { mode: 'opfs', capability: outcome.capability, store, project, hydration };
}
