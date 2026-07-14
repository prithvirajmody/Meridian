/**
 * How a service reacts to a failed gateway call, so "valid partial state" is a
 * structural property rather than an aspiration (ADR-0032 §core invariant):
 *
 * - `stop-budget`   — the budget guard tripped (ADR-0032). Stop issuing calls;
 *                     this unit and every remaining unit fall back to the
 *                     deterministic floor. The graph stays complete and valid,
 *                     just partially enriched, and the boundary is reported.
 * - `degrade-unit`  — the model refused or produced schema-invalid output after
 *                     one repair (ADR-0031 §honest rejection). This one unit
 *                     falls back to the floor; other units proceed.
 * - `propagate`     — a genuine setup/consistency error (replay miss, bad
 *                     config, cancellation). Not graceful degradation — rethrow,
 *                     because silently flooring these would hide a real fault.
 */
import { type AiError, isAiError } from '@meridian/ai';

export type Disposition = 'stop-budget' | 'degrade-unit' | 'propagate';

export function classify(error: unknown): Disposition {
  if (!isAiError(error)) return 'propagate';
  const kind = (error as AiError).kind;
  if (kind === 'budget_exceeded') return 'stop-budget';
  if (kind === 'refusal' || kind === 'schema_invalid') return 'degrade-unit';
  return 'propagate';
}
