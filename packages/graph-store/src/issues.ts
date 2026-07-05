/**
 * Typed failures of the write path (ADR-0005). Errors are values at
 * boundaries (§17.1): rejected deltas return these; exceptions stay reserved
 * for programming errors (re-entrancy, invalid createStore input).
 */

export type StoreIssueCode =
  // delta envelope
  | 'invalid-delta'
  | 'empty-delta'
  | 'stale-delta'
  // op preconditions
  | 'unknown-graph'
  | 'unknown-node'
  | 'unknown-edge'
  | 'duplicate-id'
  | 'unknown-detail-graph'
  | 'detail-not-root'
  | 'containment-cycle'
  | 'node-has-edges'
  | 'graph-not-empty'
  | 'graph-contained'
  | 'cross-graph-edge'
  // payload validity
  | 'invalid-op'
  | 'invalid-id'
  | 'invalid-kind'
  | 'invalid-attr-key'
  | 'reserved-core-key'
  | 'invalid-attr-value'
  | 'invalid-weight'
  | 'invalid-provenance'
  | 'invalid-domain'
  // assertions & control flow
  | 'op-conflict'
  | 'transaction-aborted';

export interface StoreIssue {
  readonly code: StoreIssueCode;
  readonly message: string;
  /** Index of the failing op within the submitted delta, where applicable. */
  readonly opIndex?: number;
  readonly graphId?: string;
  readonly elementId?: string;
  /** JSON path, for script (decode) issues. */
  readonly path?: string;
}
