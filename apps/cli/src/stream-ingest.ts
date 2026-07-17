/**
 * Phase-11 streaming ingest composition for the CLI. Plugin emissions flow
 * through a one-item acknowledged async source into graph-store staging; the
 * caller receives a publishable space only after parser, gate, store, backend,
 * and progress work all finish successfully.
 */
import {
  createGraphSpace,
  decode,
  encode,
  type DocumentProducer,
  type GraphSpace,
  type Issue,
} from '@meridian/graph-core';
import {
  decodeDeltaInput,
  stageDeltaStream,
  type GraphDeltaInput,
  type StageDeltaStreamFailure,
  type StageDeltaStreamProgress,
  type StageDeltaStreamStats,
  type StorageBackend,
} from '@meridian/graph-store';
import type { Progress, SourceDescriptor } from '@meridian/plugin-api';
import type {
  PluginHost,
  StreamingIngestOutcome,
} from '@meridian/plugin-host';

export interface StreamMaterializeOptions {
  readonly parser?: string;
  readonly maxOpsPerBatch?: number;
  /** Optional private persistence target; it is publishable only on success. */
  readonly backend?: StorageBackend;
  readonly settle?: () => void | Promise<void>;
  readonly onBackendError?: (error: unknown) => void;
  readonly onParserProgress?: (progress: Progress) => void | Promise<void>;
  readonly onStageProgress?: (progress: StageDeltaStreamProgress) => void | Promise<void>;
}

export interface StreamedMaterialization {
  readonly space: GraphSpace;
  readonly producer: DocumentProducer;
}

export type StreamMaterializeFailureReason =
  | 'host'
  | 'document-gate'
  | 'delta-gate'
  | 'stage'
  | 'final-gate'
  | 'unsupported-emission';

export type StreamMaterializeResult =
  | {
      readonly ok: true;
      readonly outcome: Extract<StreamingIngestOutcome, { readonly ok: true }>;
      readonly materialized: StreamedMaterialization;
      readonly stageStats: StageDeltaStreamStats;
    }
  | {
      readonly ok: false;
      readonly reason: StreamMaterializeFailureReason;
      readonly message: string;
      readonly outcome: StreamingIngestOutcome;
      readonly stageStats: StageDeltaStreamStats;
      readonly issues?: readonly Issue[] | readonly { readonly code: string; readonly message: string }[];
      readonly deltaIndex?: number;
      readonly stageFailure?: StageDeltaStreamFailure;
    };

interface PendingDelta {
  readonly delta: GraphDeltaInput;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

/**
 * A push-to-pull bridge with an acknowledgement boundary. `push` resolves only
 * when stageDeltaStream has finished the yielded envelope and asks for the next
 * one, so PluginHost's serialized consumer queue provides real backpressure.
 */
class AcknowledgedDeltaSource implements AsyncIterable<GraphDeltaInput> {
  private queued: PendingDelta | undefined;
  private waiter: ((item: PendingDelta | undefined) => void) | undefined;
  private closed = false;
  private cancelled: unknown;

  push(delta: GraphDeltaInput): Promise<void> {
    if (this.closed) return Promise.reject(new Error('delta staging source is closed'));
    if (this.cancelled !== undefined) return Promise.reject(this.cancelled);
    if (this.queued !== undefined) {
      return Promise.reject(new Error('delta staging source exceeded its one-envelope bound'));
    }
    return new Promise<void>((resolve, reject) => {
      const item = { delta, resolve, reject };
      const waiter = this.waiter;
      if (waiter !== undefined) {
        this.waiter = undefined;
        waiter(item);
      } else {
        this.queued = item;
      }
    });
  }

  close(): void {
    this.closed = true;
    if (this.queued === undefined && this.waiter !== undefined) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter(undefined);
    }
  }

  private take(): Promise<PendingDelta | undefined> {
    const queued = this.queued;
    if (queued !== undefined) {
      this.queued = undefined;
      return Promise.resolve(queued);
    }
    if (this.closed || this.cancelled !== undefined) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  private cancel(reason: unknown): void {
    if (this.cancelled === undefined) this.cancelled = reason;
    this.queued?.reject(reason);
    this.queued = undefined;
    if (this.waiter !== undefined) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter(undefined);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<GraphDeltaInput> {
    let active: PendingDelta | undefined;
    return {
      next: async (): Promise<IteratorResult<GraphDeltaInput>> => {
        // stageDeltaStream asks for the next item only after the prior envelope
        // has been fully applied, storage-settled, and progress-acknowledged.
        active?.resolve();
        active = undefined;
        const item = await this.take();
        if (item === undefined) return { done: true, value: undefined };
        active = item;
        return { done: false, value: item.delta };
      },
      return: async (): Promise<IteratorResult<GraphDeltaInput>> => {
        const reason = new Error('delta staging stopped before accepting the queued envelope');
        active?.reject(reason);
        active = undefined;
        this.cancel(reason);
        return { done: true, value: undefined };
      },
    };
  }
}

const EMPTY_STAGE_STATS: StageDeltaStreamStats = {
  emissions: 0,
  inputOps: 0,
  batches: 0,
  appliedOps: 0,
  settledBatches: 0,
  storageSettles: 0,
  peakBufferedOps: 0,
};

/**
 * Stream one arbitrated parser into private staging and gate the materialized
 * result. No document/delta arrays are accumulated: at most one accepted
 * document (the legacy shape) or one acknowledged delta envelope is retained.
 */
export async function materializeStreamedSource(
  host: PluginHost,
  src: SourceDescriptor,
  options: StreamMaterializeOptions = {},
): Promise<StreamMaterializeResult> {
  const vocabulary = host.vocabulary();
  const source = new AcknowledgedDeltaSource();
  let firstDocument: StreamedMaterialization | undefined;
  let documentGateIssues: readonly Issue[] | undefined;
  let deltaGate:
    | { readonly index: number; readonly issues: readonly { readonly code: string; readonly message: string }[] }
    | undefined;
  let nextDeltaIndex = 0;

  const stagePromise = stageDeltaStream(createGraphSpace(), source, {
    ...(options.maxOpsPerBatch !== undefined ? { maxOpsPerBatch: options.maxOpsPerBatch } : {}),
    ...(options.backend !== undefined ? { backend: options.backend } : {}),
    ...(options.settle !== undefined ? { settle: options.settle } : {}),
    ...(options.onBackendError !== undefined ? { onBackendError: options.onBackendError } : {}),
    ...(options.onStageProgress !== undefined ? { onProgress: options.onStageProgress } : {}),
  });

  const outcome = await host.ingestStreaming(
    src,
    {
      emitDocument: (doc) => {
        // More than one document is unsupported and therefore need not be
        // retained. Gate only the first so a parser bug still has exact issues.
        if (firstDocument !== undefined || documentGateIssues !== undefined) return;
        const gated = decode(doc, { vocabulary });
        if (!gated.ok) {
          documentGateIssues = gated.errors;
          return;
        }
        firstDocument = { space: gated.space, producer: doc.producer };
      },
      emitDelta: async (wire) => {
        const index = nextDeltaIndex++;
        const decoded = decodeDeltaInput(wire);
        if (!decoded.ok) {
          deltaGate = { index, issues: decoded.errors };
          throw new Error(`delta ${index} does not parse`);
        }
        await source.push(decoded.delta);
      },
      ...(options.onParserProgress !== undefined ? { progress: options.onParserProgress } : {}),
    },
    options.parser !== undefined ? { parser: options.parser } : {},
  );
  source.close();
  const staged = await stagePromise;
  const stageStats = staged.stats ?? EMPTY_STAGE_STATS;

  if (documentGateIssues !== undefined) {
    return {
      ok: false,
      reason: 'document-gate',
      message: 'parser emitted an invalid document',
      outcome,
      stageStats,
      issues: documentGateIssues,
    };
  }
  if (deltaGate !== undefined) {
    return {
      ok: false,
      reason: 'delta-gate',
      message: `delta ${deltaGate.index} does not parse`,
      outcome,
      stageStats,
      issues: deltaGate.issues,
      deltaIndex: deltaGate.index,
    };
  }
  if (!staged.ok) {
    return {
      ok: false,
      reason: 'stage',
      message: staged.failure.message,
      outcome,
      stageStats,
      stageFailure: staged.failure,
      ...(staged.failure.errors !== undefined ? { issues: staged.failure.errors } : {}),
    };
  }
  if (!outcome.ok) {
    return {
      ok: false,
      reason: 'host',
      message: outcome.issue.message,
      outcome,
      stageStats,
    };
  }

  const { documents, deltas } = outcome.report;
  if (!((documents === 1 && deltas === 0) || (documents === 0 && deltas > 0))) {
    return {
      ok: false,
      reason: 'unsupported-emission',
      message: `parser emitted ${documents} documents and ${deltas} deltas`,
      outcome,
      stageStats,
    };
  }

  if (documents === 1) {
    if (firstDocument === undefined) {
      return {
        ok: false,
        reason: 'document-gate',
        message: 'parser document was not materialized',
        outcome,
        stageStats,
      };
    }
    return { ok: true, outcome, materialized: firstDocument, stageStats };
  }

  // The op decoder/store gate checks structure; this final graph-core gate also
  // applies the host's registered kind/attribute vocabulary to the whole space.
  const finalGate = decode(encode(staged.space), { vocabulary });
  if (!finalGate.ok) {
    return {
      ok: false,
      reason: 'final-gate',
      message: 'replayed deltas violate the registered vocabulary',
      outcome,
      stageStats,
      issues: finalGate.errors,
    };
  }
  const plugin = host.plugins().find((candidate) => candidate.manifest.name === outcome.plugin);
  if (plugin === undefined) {
    return {
      ok: false,
      reason: 'host',
      message: `selected plugin "${outcome.plugin}" is no longer registered`,
      outcome,
      stageStats,
    };
  }
  return {
    ok: true,
    outcome,
    materialized: {
      space: finalGate.space,
      producer: { name: plugin.manifest.name, version: plugin.manifest.version },
    },
    stageStats,
  };
}
