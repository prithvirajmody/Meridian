/**
 * Bounded, caller-owned staging for streamed graph deltas (Phase 11).
 *
 * The store built here is private until the source, every apply, persistence,
 * and progress callback completes. A failure result deliberately contains no
 * store or space: callers publish only the success branch and discard the
 * staging backend on every failure branch.
 */
import type { GraphSpace } from '@meridian/graph-core';
import type { StoreIssue } from './issues.js';
import type { GraphDeltaInput } from './ops.js';
import {
  createStore,
  settleStoreBackend,
  type GraphStore,
  type StorageBackend,
} from './store.js';
import type { VersionStamp } from './version.js';

export type StageDeltaStreamFailureCode =
  | 'invalid-options'
  | 'aborted'
  | 'source-failed'
  | 'apply-failed'
  | 'storage-failed'
  | 'progress-failed';

/** Aggregate counters for a staging run. No counter includes queued work. */
export interface StageDeltaStreamStats {
  /** Delta envelopes pulled from the source. */
  readonly emissions: number;
  /** Input ops observed, including ops in an envelope that later fails. */
  readonly inputOps: number;
  /** Batches committed to the private in-memory store. */
  readonly batches: number;
  /** Input ops committed to the private in-memory store. */
  readonly appliedOps: number;
  /** Committed batches whose backend queue and optional settle hook completed. */
  readonly settledBatches: number;
  /** Calls made to the optional storage settle hook. */
  readonly storageSettles: number;
  /** Largest copied op batch retained by the orchestrator at one time. */
  readonly peakBufferedOps: number;
}

/** Progress emitted after one batch is both applied and storage-settled. */
export interface StageDeltaStreamProgress extends StageDeltaStreamStats {
  /** Zero-based source-envelope index. */
  readonly emissionIndex: number;
  /** Zero-based offset of this batch within that envelope. */
  readonly opOffset: number;
  readonly version: VersionStamp;
}

export interface StageDeltaStreamFailure {
  readonly code: StageDeltaStreamFailureCode;
  readonly message: string;
  /** Zero-based source-envelope index, when one had been pulled. */
  readonly emissionIndex?: number;
  /** Zero-based op offset within the source envelope, when applicable. */
  readonly opOffset?: number;
  /** Ordinary GraphStore validation/apply issues. */
  readonly errors?: readonly StoreIssue[];
  /** Original source, storage, or callback failure for diagnostics. */
  readonly cause?: unknown;
}

export interface StageDeltaStreamOptions {
  /** Maximum copied/apply batch size. Defaults to 1024 ops. */
  readonly maxOpsPerBatch?: number;
  /** Private persistence backend that belongs to this staging run. */
  readonly backend?: StorageBackend;
  /** Durable version seed preserved by the returned staged store. */
  readonly initialVersion?: VersionStamp;
  readonly onListenerError?: (error: unknown) => void;
  readonly onBackendError?: (error: unknown) => void;
  /**
   * Optional backend flush/checkpoint hook. It is awaited after the store's
   * appendOps/persist queue at every batch boundary (and once for an empty
   * stream), providing backpressure for backends that buffer internally.
   */
  readonly settle?: () => void | Promise<void>;
  readonly signal?: AbortSignal;
  /** Awaited after each settled batch, so progress itself cannot run ahead. */
  readonly onProgress?: (progress: StageDeltaStreamProgress) => void | Promise<void>;
}

export type StageDeltaStreamResult =
  | {
      readonly ok: true;
      readonly store: GraphStore;
      readonly space: GraphSpace;
      readonly stats: StageDeltaStreamStats;
    }
  | {
      readonly ok: false;
      readonly failure: StageDeltaStreamFailure;
      readonly stats: StageDeltaStreamStats;
    };

interface MutableStats {
  emissions: number;
  inputOps: number;
  batches: number;
  appliedOps: number;
  settledBatches: number;
  storageSettles: number;
  peakBufferedOps: number;
}

const DEFAULT_MAX_OPS_PER_BATCH = 1024;

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Apply an iterable/async-iterable delta stream into a private store using
 * bounded op batches. The input envelope remains atomic from the publisher's
 * perspective: chunk commits are visible only inside staging, and every
 * non-success outcome withholds that staging store.
 */
export async function stageDeltaStream(
  initialSpace: GraphSpace,
  source: Iterable<GraphDeltaInput> | AsyncIterable<GraphDeltaInput>,
  options: StageDeltaStreamOptions = {},
): Promise<StageDeltaStreamResult> {
  const stats: MutableStats = {
    emissions: 0,
    inputOps: 0,
    batches: 0,
    appliedOps: 0,
    settledBatches: 0,
    storageSettles: 0,
    peakBufferedOps: 0,
  };
  const snapshotStats = (): StageDeltaStreamStats => ({ ...stats });
  const failed = (failure: StageDeltaStreamFailure): StageDeltaStreamResult => ({
    ok: false,
    failure,
    stats: snapshotStats(),
  });

  const maxOps = options.maxOpsPerBatch ?? DEFAULT_MAX_OPS_PER_BATCH;
  // Read through a function because AbortSignal changes asynchronously; a
  // one-time TypeScript narrowing must not freeze its runtime state.
  const isAborted = (): boolean => options.signal?.aborted ?? false;
  if (!Number.isSafeInteger(maxOps) || maxOps <= 0) {
    return failed({
      code: 'invalid-options',
      message: `maxOpsPerBatch must be a positive safe integer, got ${String(maxOps)}`,
    });
  }
  if (isAborted()) {
    return failed({ code: 'aborted', message: 'delta stream staging was aborted before it started' });
  }

  let backendFailed = false;
  let backendFailure: unknown;
  const store = createStore(initialSpace, {
    ...(options.backend !== undefined ? { backend: options.backend } : {}),
    ...(options.initialVersion !== undefined ? { initialVersion: options.initialVersion } : {}),
    ...(options.onListenerError !== undefined ? { onListenerError: options.onListenerError } : {}),
    onBackendError: (error) => {
      if (!backendFailed) {
        backendFailed = true;
        backendFailure = error;
      }
      options.onBackendError?.(error);
    },
  });

  const settleBatch = async (
    emissionIndex: number,
    opOffset: number,
  ): Promise<StageDeltaStreamFailure | undefined> => {
    await settleStoreBackend(store);
    if (backendFailed) {
      return {
        code: 'storage-failed',
        message: `staging backend failed after batch at emission ${emissionIndex}, op ${opOffset}: ${failureMessage(backendFailure)}`,
        emissionIndex,
        opOffset,
        cause: backendFailure,
      };
    }
    if (options.settle !== undefined) {
      try {
        await options.settle();
        stats.storageSettles += 1;
      } catch (cause) {
        return {
          code: 'storage-failed',
          message: `staging backend settle failed after batch at emission ${emissionIndex}, op ${opOffset}: ${failureMessage(cause)}`,
          emissionIndex,
          opOffset,
          cause,
        };
      }
    }
    stats.settledBatches += 1;
    return undefined;
  };

  let emissionIndex = 0;
  try {
    for await (const emission of source) {
      if (isAborted()) {
        return failed({
          code: 'aborted',
          message: `delta stream staging was aborted before emission ${emissionIndex}`,
          emissionIndex,
        });
      }

      stats.emissions += 1;
      stats.inputOps += emission.ops.length;

      // Preserve GraphStore's empty-delta and envelope validation semantics.
      if (emission.ops.length === 0) {
        const result = store.apply(emission);
        if (!result.ok) {
          return failed({
            code: 'apply-failed',
            message: `delta stream apply failed at emission ${emissionIndex}, op 0: ${result.errors[0]?.message ?? 'unknown store issue'}`,
            emissionIndex,
            opOffset: 0,
            errors: result.errors,
          });
        }
      }

      for (let opOffset = 0; opOffset < emission.ops.length; opOffset += maxOps) {
        if (isAborted()) {
          return failed({
            code: 'aborted',
            message: `delta stream staging was aborted at emission ${emissionIndex}, op ${opOffset}`,
            emissionIndex,
            opOffset,
          });
        }

        const ops = emission.ops.slice(opOffset, opOffset + maxOps);
        stats.peakBufferedOps = Math.max(stats.peakBufferedOps, ops.length);
        const batch: GraphDeltaInput = {
          origin: emission.origin,
          ops,
          ...(opOffset === 0 && emission.baseVersion !== undefined
            ? { baseVersion: emission.baseVersion }
            : {}),
        };

        let result;
        try {
          result = store.apply(batch);
        } catch (cause) {
          return failed({
            code: 'apply-failed',
            message: `delta stream apply threw at emission ${emissionIndex}, op ${opOffset}: ${failureMessage(cause)}`,
            emissionIndex,
            opOffset,
            cause,
          });
        }
        if (!result.ok) {
          return failed({
            code: 'apply-failed',
            message: `delta stream apply failed at emission ${emissionIndex}, op ${opOffset}: ${result.errors[0]?.message ?? 'unknown store issue'}`,
            emissionIndex,
            opOffset,
            errors: result.errors,
          });
        }
        stats.batches += 1;
        stats.appliedOps += ops.length;

        const storageFailure = await settleBatch(emissionIndex, opOffset);
        if (storageFailure !== undefined) return failed(storageFailure);

        if (options.onProgress !== undefined) {
          try {
            await options.onProgress({
              ...snapshotStats(),
              emissionIndex,
              opOffset,
              version: store.version(),
            });
          } catch (cause) {
            return failed({
              code: 'progress-failed',
              message: `delta stream progress callback failed at emission ${emissionIndex}, op ${opOffset}: ${failureMessage(cause)}`,
              emissionIndex,
              opOffset,
              cause,
            });
          }
        }
      }
      emissionIndex += 1;
    }
  } catch (cause) {
    return failed({
      code: isAborted() ? 'aborted' : 'source-failed',
      message:
        isAborted()
          ? `delta stream staging was aborted before emission ${emissionIndex}`
          : `delta stream source failed before emission ${emissionIndex}: ${failureMessage(cause)}`,
      emissionIndex,
      cause,
    });
  }

  if (isAborted()) {
    return failed({
      code: 'aborted',
      message: 'delta stream staging was aborted before publication',
      emissionIndex,
    });
  }

  // Even an empty stream may have a backend that buffers initialization.
  if (stats.batches === 0 && options.settle !== undefined) {
    try {
      await options.settle();
      stats.storageSettles += 1;
    } catch (cause) {
      return failed({
        code: 'storage-failed',
        message: `staging backend settle failed before publication: ${failureMessage(cause)}`,
        cause,
      });
    }
  }

  return { ok: true, store, space: store.snapshot(), stats: snapshotStats() };
}
