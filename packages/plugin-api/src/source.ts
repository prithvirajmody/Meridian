/**
 * What a parser is asked to ingest. Deliberately dumb data (ADR-0009): the
 * host resolves I/O; parsers see bytes/text, never the filesystem or network.
 */
export interface SourceDescriptor {
  /** Stable identity of the source; also the ID-derivation source key (U4). */
  readonly uri: string;
  readonly mediaType?: string;
  readonly text?: string;
  readonly bytes?: Uint8Array;
  readonly meta?: Readonly<Record<string, string>>;
}

/** Streamed ingest progress; purely informational. */
export interface Progress {
  readonly stage: string;
  readonly done: number;
  readonly total?: number;
}

/**
 * One file-level change fed to an {@link IncrementalAdapter} (ROADMAP Phase 7
 * §7). Deliberately dumb data, like {@link SourceDescriptor}: the composition
 * root owns the filesystem and hands the adapter text, never a path to read
 * (ADR-0009).
 *
 * - `newText` absent ⇒ the file was **deleted**.
 * - `oldText` absent ⇒ the file was **added** (or the caller does not retain the
 *   previous text; a stateful adapter already holds its own prior view, so
 *   `oldText` is advisory).
 * - both present ⇒ a **modification**.
 *
 * `path` is the repository-relative POSIX path — the ADR-0028 `source`
 * coordinate, the stable key an incremental re-parse diffs against.
 */
export interface SourceChange {
  readonly path: string;
  readonly oldText?: string;
  readonly newText?: string;
}
