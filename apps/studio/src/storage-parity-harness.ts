/**
 * Browser binding of the 11D runtime-parity suite: the same scenario
 * objects the Node vitest run executes (packages/store-sqlite/src/parity.ts)
 * run here against the OPFS worker backend, plus the OPFS-unavailable
 * fallback probe. Exposed on `window.__MERIDIAN_STORAGE_PARITY__` for the
 * Playwright gate (e2e/storage-parity.spec.ts); loaded only under `?e2e=1`.
 */
import { encodePretty, type GraphId } from '@meridian/graph-core';
import {
  paritySpace,
  runParityScenarios,
  type ParityOpenOptions,
  type ParityOutcome,
  type ParitySession,
  type ParityStack,
} from '@meridian/store-sqlite';
import {
  openBrowserProjectStore,
  wipeBrowserProjects,
} from '@meridian/store-sqlite/browser';

const PROJECT_NAME = 'parity.meridian';

function storageWorkerFactory(): Worker {
  return new Worker(new URL('./storage-worker-entry.ts', import.meta.url), { type: 'module' });
}

function browserStack(): ParityStack {
  // A failed scenario must not leak a live worker holding the OPFS pool
  // hostage for every later scenario — reset closes leftovers first.
  const openSessions = new Set<ParitySession>();
  return {
    async reset(): Promise<void> {
      for (const leftover of [...openSessions]) {
        openSessions.delete(leftover);
        try {
          await leftover.close();
        } catch {
          // already dead is fine
        }
      }
      const wiped = await wipeBrowserProjects(storageWorkerFactory);
      if (!wiped.ok) throw new Error(`OPFS pool reset failed: ${wiped.reason ?? 'unknown'}`);
    },
    async open(opts: ParityOpenOptions = {}): Promise<ParitySession> {
      const session = await openBrowserProjectStore(PROJECT_NAME, {
        workerFactory: storageWorkerFactory,
        ...opts,
      });
      if (session.mode !== 'opfs' || session.project === undefined) {
        throw new Error(`expected an OPFS session, got ${session.mode}: ${session.reason ?? ''}`);
      }
      const project = session.project;
      const handle: ParitySession = {
        space: project.space,
        version: project.version,
        replayedDeltas: project.replayedDeltas,
        ...(project.manifest ? { manifest: project.manifest } : {}),
        store: session.store,
        ...(session.hydration ? { hydration: session.hydration } : {}),
        flush: () => project.flush(),
        close: async () => {
          openSessions.delete(handle);
          await project.close();
        },
        abandon: async () => {
          openSessions.delete(handle);
          await project.abandon();
        },
      };
      openSessions.add(handle);
      return handle;
    },
  };
}

export interface StorageParityApi {
  run(): Promise<ParityOutcome[]>;
  fallback(): Promise<{
    mode: string;
    reason?: string;
    storeWorks: boolean;
    exportWorks: boolean;
  }>;
}

export function createStorageParityApi(): StorageParityApi {
  return {
    run(): Promise<ParityOutcome[]> {
      return runParityScenarios(browserStack());
    },

    /** OPFS unavailable → clean fallback: an in-memory session that still
     * mutates and exports (persistence is an enhancement, ADR-0038 §7). */
    async fallback(): Promise<{ mode: string; reason?: string; storeWorks: boolean; exportWorks: boolean }> {
      const session = await openBrowserProjectStore('fallback-probe.meridian', {
        workerFactory: storageWorkerFactory,
        forceUnavailable: true,
        initialSpace: paritySpace(),
      });
      const applied = session.store.apply({
        origin: { actor: 'fallback-probe' },
        ops: [
          {
            t: 'graph:add',
            graph: 'g-fallback' as GraphId,
            meta: { label: 'Fallback', domain: 'parity', provenance: { origin: 'derived' } },
          },
        ],
      });
      const exported = encodePretty(session.store.snapshot());
      return {
        mode: session.mode,
        ...(session.reason !== undefined ? { reason: session.reason } : {}),
        storeWorks: applied.ok && session.store.snapshot().graphs.has('g-fallback' as GraphId),
        exportWorks: exported.includes('g-fallback'),
      };
    },
  };
}
