/**
 * Typed host failures (ADR-0009 rule 4): every way a plugin or source can go
 * wrong is a located, stable-coded issue — never an uncaught throw out of the
 * host, never a crash that takes the host down.
 */
export type HostIssueCode =
  | 'invalid-manifest'
  | 'duplicate-plugin'
  | 'api-version-incompatible'
  | 'activation-failed'
  | 'exports-mismatch'
  | 'vocabulary-conflict'
  | 'capability-conflict'
  | 'no-parser'
  | 'ambiguous-source'
  | 'unknown-parser'
  | 'ingest-failed';

export interface HostIssue {
  readonly code: HostIssueCode;
  readonly message: string;
  /** Manifest name of the plugin involved, when one is. */
  readonly plugin?: string;
}
