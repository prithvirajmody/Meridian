/**
 * `summarizeCut` (subphase 8D): name + summarize a set of rollup (cluster)
 * nodes through the gateway, unit by unit. It is the atomic-per-unit shape
 * ADR-0032 requires: each rollup is one work-unit, so a budget trip falls
 * cleanly *between* units — every rollup before the stop carries an AI name;
 * every rollup at or after it retains its deterministic-floor name (§8.1.1).
 * The graph is therefore always complete and valid, just partially enriched,
 * and the enriched/floored boundary is reported (ADR-0032 §clearly-marked).
 *
 * Pure w.r.t. the graph — it never writes; it returns summaries the caller
 * turns into proposals (ADR-0031). The only effect is the metered gateway call.
 */
import { type AiSession, type BudgetState } from '@meridian/ai';
import { classify } from './disposition.js';
import { type MemberDigest, type RollupPromptInput, SUMMARIZE_ROLLUP_PROMPT } from './prompts/summarize-rollup.js';
import { type AiProvenance, provenanceOfCall } from './provenance.js';

/** One rollup node to be named/summarized. */
export interface RollupInput {
  /** The (deterministic, stable) group-node id this summary is for. */
  readonly id: string;
  /** Domain the rollup lives in (namespacing + prompt context). */
  readonly domain: string;
  /** Member node ids the rollup stands in for. */
  readonly members: readonly string[];
  /** Salient per-member facts for the prompt; sorted by the caller. */
  readonly digest: readonly MemberDigest[];
  /** Deterministic-floor name, used when AI is skipped/unavailable. */
  readonly fallbackName: string;
  /** Deterministic-floor summary, used when AI is skipped/unavailable. */
  readonly fallbackSummary: string;
}

/** The name+summary for one rollup, and whether AI or the floor produced it. */
export interface RollupSummary {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  /** AI-calibrated confidence in [0,1]; `0` for a deterministic floor. */
  readonly confidence: number;
  /** true = AI-enriched; false = deterministic floor (budget/refusal/invalid). */
  readonly enriched: boolean;
  /** The reproducible call that produced an enriched summary (ADR-0031). */
  readonly provenance?: AiProvenance;
}

export interface SummarizeCutOptions {
  readonly signal?: AbortSignal;
  /** Cap on member digests rendered per rollup (prompt-size guard). Default 40. */
  readonly maxMembersPerRollup?: number;
}

export interface SummarizeCutResult {
  readonly summaries: readonly RollupSummary[];
  /** How many rollups AI enriched. */
  readonly enriched: number;
  /** How many fell back to the deterministic floor. */
  readonly floored: number;
  /** True iff the budget guard hard-stopped mid-run (ADR-0032). */
  readonly stoppedByBudget: boolean;
  /** Final gateway budget state (spend so far, tripped flag). */
  readonly budget: BudgetState;
}

const DEFAULT_MAX_MEMBERS = 40;

function floor(rollup: RollupInput): RollupSummary {
  return {
    id: rollup.id,
    name: rollup.fallbackName,
    summary: rollup.fallbackSummary,
    confidence: 0,
    enriched: false,
  };
}

/**
 * Summarize every rollup, in input order (the caller orders deterministically).
 * Live-cache hits are free; replay hits are metered from recorded usage while
 * remaining zero-network (ADR-0030/0032). A non-degradable error (replay
 * miss, cancellation, bad config) propagates — flooring it would hide a fault.
 */
export async function summarizeCut(
  session: AiSession,
  rollups: readonly RollupInput[],
  options: SummarizeCutOptions = {},
): Promise<SummarizeCutResult> {
  const cap = options.maxMembersPerRollup ?? DEFAULT_MAX_MEMBERS;
  const summaries: RollupSummary[] = [];
  let stopped = false;
  let enriched = 0;
  let floored = 0;

  for (const rollup of rollups) {
    if (stopped) {
      summaries.push(floor(rollup));
      floored += 1;
      continue;
    }
    const promptInput: RollupPromptInput = {
      domain: rollup.domain,
      members: rollup.digest.slice(0, cap),
      totalMembers: rollup.members.length,
    };
    try {
      const res = await session.call(SUMMARIZE_ROLLUP_PROMPT, promptInput, {
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      summaries.push({
        id: rollup.id,
        name: res.value.name,
        summary: res.value.summary,
        confidence: res.value.confidence,
        enriched: true,
        provenance: provenanceOfCall(res),
      });
      enriched += 1;
    } catch (error) {
      const disposition = classify(error);
      if (disposition === 'propagate') throw error;
      if (disposition === 'stop-budget') stopped = true;
      summaries.push(floor(rollup));
      floored += 1;
    }
  }

  return { summaries, enriched, floored, stoppedByBudget: stopped, budget: session.budget };
}
