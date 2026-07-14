import { canonicalInputHash } from './hash.js';

/**
 * Session modes (ADR-0030):
 * - `off`   — no cache read or write; every call hits the provider (no determinism).
 * - `live`  — cache-through: read; on miss call the provider and store the result.
 * - `record`— always call the provider and (over)write the store; builds fixtures.
 * - `replay`— read only; a miss is a hard error and no provider call is made.
 *             This is the CI mode: cache miss = test failure, never a network call.
 */
export type SessionMode = 'off' | 'live' | 'record' | 'replay';

/**
 * Embeddings are not rendered from a versioned `PromptSpec`, so the gateway keys
 * them under this single fixed `promptVersion`. It is the one source of truth for
 * both the embedding cache key (session.embed) and the provenance stamped onto
 * embedding-derived proposals, so a proposal always names the call that made it.
 */
export const EMBEDDING_PROMPT_VERSION = 'embedding';

/** The identifying components of a cached response (ADR-0030, §8.3 cache key). */
export interface ResponseKey {
  readonly kind: 'completion' | 'embedding';
  readonly providerId: string;
  readonly model: string;
  readonly promptId: string;
  readonly promptVersion: string;
  readonly inputHash: string;
  /** Distinguishes the one repair round-trip from the primary call. */
  readonly attempt: 'primary' | 'repair';
}

export interface StoredResponse {
  readonly meta: ResponseKey;
  /** The normalized CompletionResult or EmbeddingResult, as plain JSON. */
  readonly value: unknown;
}

/** Content-addressed response store — doubles as the record/replay fixture store. */
export interface ResponseStore {
  get(keyHash: string): Promise<StoredResponse | undefined>;
  set(keyHash: string, value: StoredResponse): Promise<void>;
}

/** Canonical, order-independent hash of a response key. */
export function deriveKeyHash(key: ResponseKey): string {
  return canonicalInputHash(key);
}

/**
 * In-memory store. `snapshot`/`load` (de)serialize the whole fixture set as
 * plain JSON so recorded fixtures can be written to disk by the record-mode
 * driver and reloaded for replay in CI — with no filesystem dependency here,
 * keeping the package isomorphic.
 */
export class MemoryResponseStore implements ResponseStore {
  private readonly map = new Map<string, StoredResponse>();

  constructor(initial?: Readonly<Record<string, StoredResponse>>) {
    if (initial) for (const [k, v] of Object.entries(initial)) this.map.set(k, v);
  }

  get(keyHash: string): Promise<StoredResponse | undefined> {
    return Promise.resolve(this.map.get(keyHash));
  }

  set(keyHash: string, value: StoredResponse): Promise<void> {
    this.map.set(keyHash, value);
    return Promise.resolve();
  }

  get size(): number {
    return this.map.size;
  }

  snapshot(): Record<string, StoredResponse> {
    return Object.fromEntries(this.map);
  }

  load(entries: Readonly<Record<string, StoredResponse>>): void {
    for (const [k, v] of Object.entries(entries)) this.map.set(k, v);
  }
}
