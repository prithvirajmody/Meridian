/**
 * Serializable parse-worker protocol shared by host and worker. This module is
 * intentionally runtime-neutral: the main-thread host must not import the
 * tree-sitter parser shim merely to speak RPC.
 */
import type { RawBody } from '../detail/types.js';
import type { CodeLanguage } from '../languages.js';
import type { RawModule } from '../map/raw.js';
import type { ParseOutcome } from '../parse.js';

/** Host→worker control message (over the dedicated control port). */
export interface CancelMessage {
  readonly type: 'cancel';
  readonly requestId: number;
}

/** Worker→host control acknowledgement (observability). */
export interface CancelledMessage {
  readonly type: 'cancelled';
  readonly requestId: number;
}

/** The worker's view of the dedicated control port (adapted by the entry shim). */
export interface WorkerControlChannel {
  postMessage(msg: CancelledMessage): void;
  onMessage(cb: (msg: CancelMessage) => void): void;
}

export interface ParseRequest {
  readonly requestId: number;
  readonly language: CodeLanguage;
  readonly text: string;
}

/** A {@link ParseOutcome} plus worker-side timing (budget observability). */
export interface ParseResponse extends ParseOutcome {
  readonly requestId: number;
  readonly parseTimeMs: number;
}

/** A map request: like {@link ParseRequest} plus source coordinates. */
export interface MapRequest {
  readonly requestId: number;
  readonly language: CodeLanguage;
  readonly source: string;
  readonly label: string;
  readonly text: string;
}

export interface MapResponse {
  readonly requestId: number;
  readonly module: RawModule;
  readonly mapTimeMs: number;
}

/** A body-resolve request for a function/method declaration span. */
export interface ResolveBodyRequest {
  readonly requestId: number;
  readonly language: CodeLanguage;
  readonly text: string;
  readonly declSpan: readonly [number, number];
}

export interface ResolveBodyResponse {
  readonly requestId: number;
  readonly body: RawBody | undefined;
  readonly resolveTimeMs: number;
}

/** The Comlink-exposed worker surface. */
export interface ParseWorkerApi {
  warm(language: CodeLanguage): Promise<void>;
  parse(req: ParseRequest): Promise<ParseResponse>;
  map(req: MapRequest): Promise<MapResponse>;
  resolveBody(req: ResolveBodyRequest): Promise<ResolveBodyResponse>;
}

/** Portable `AbortError` (`DOMException` where available). */
export function abortError(): Error {
  try {
    return new DOMException('Aborted', 'AbortError');
  } catch {
    const error = new Error('Aborted');
    error.name = 'AbortError';
    return error;
  }
}
