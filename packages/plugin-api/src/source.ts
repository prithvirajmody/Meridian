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
