/**
 * The Studio AI human-trust controller (subphase 8F). It is the imperative
 * service that turns AI *proposals* into graph structure through the **one write
 * path** (ADR-0031/ADR-0005): acceptance calls `applyProposal`, which commits
 * ordinary op-based deltas whose nodes carry `provenance.origin === 'ai'`. The
 * controller never touches the store engine directly and never writes AI
 * structure any other way.
 *
 * ADR-0022: this service lives outside Zustand (like the navigator). The store
 * holds only serializable proposal *descriptors*; the full `AbstractionProposal`
 * objects live here, keyed by id.
 *
 * Trust rules honoured here:
 * - **Human-in-the-loop by default.** A proposal sits `pending` until a human
 *   accepts or rejects it.
 * - **Auto-accept is opt-in, per service.** Only when a service has an explicit
 *   `AutoAcceptRule { enabled: true }` (optionally gated by a confidence floor)
 *   are its proposals accepted without a click.
 * - **Non-blocking & cancellation-aware.** `accept` yields to a microtask before
 *   writing and honours an `AbortSignal`; a cancel before the write leaves the
 *   graph untouched and the proposal back in `pending`.
 */
import {
  applyProposal,
  type AbstractionProposal,
  type ProposedGroup,
} from '@meridian/abstraction';
import type { GraphStore } from '@meridian/graph-store';
import {
  StudioStoreCommands,
  type AutoAcceptRule,
  type PendingProposal,
  type StudioStore,
} from '../store.js';

export interface ProposalSubmission {
  readonly service: string;
  readonly title?: string;
  readonly proposal: AbstractionProposal;
}

export interface AcceptOutcome {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

interface HeldProposal {
  readonly service: string;
  readonly proposal: AbstractionProposal;
}

/** Read the signal's live aborted flag. Extracted so TS does not persist a
 * narrowing across the `await` — the flag can flip while the microtask runs. */
function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function minConfidenceOf(groups: readonly ProposedGroup[]): number | null {
  let min: number | null = null;
  for (const group of groups) {
    if (group.confidence === undefined) continue;
    min = min === null ? group.confidence : Math.min(min, group.confidence);
  }
  return min;
}

/** Does an auto-accept rule clear for this proposal? A confidence floor rejects
 * proposals whose groups lack confidence or fall below the floor. */
export function autoAcceptClears(rule: AutoAcceptRule, proposal: AbstractionProposal): boolean {
  if (!rule.enabled) return false;
  if (rule.minConfidence === undefined) return true;
  return proposal.groups.every(
    (group) => group.confidence !== undefined && group.confidence >= rule.minConfidence!,
  );
}

export class AiTrustController {
  private readonly commands: StudioStoreCommands;
  private readonly held = new Map<string, HeldProposal>();
  private counter = 0;

  constructor(
    private readonly store: StudioStore,
    /** Resolves the currently-open corpus's graph store, or null before ingest. */
    private readonly graphStore: () => GraphStore | null,
  ) {
    this.commands = new StudioStoreCommands(store);
  }

  /** Queue a proposal. Returns its id. Applies immediately if the service is
   * opted into auto-accept and the proposal clears its confidence floor. */
  submit(submission: ProposalSubmission): string {
    const id = `${submission.service}-${++this.counter}`;
    const groups = submission.proposal.groups;
    const descriptor: PendingProposal = {
      id,
      service: submission.service,
      title: submission.title ?? `${groups.length} group${groups.length === 1 ? '' : 's'}`,
      groupCount: groups.length,
      minConfidence: minConfidenceOf(groups),
      status: 'pending',
      errors: [],
      receivedAtMs: this.now(),
    };
    this.held.set(id, { service: submission.service, proposal: submission.proposal });
    this.commands.upsertProposal(descriptor);

    const rule = this.store.getState().ai.autoAccept[submission.service];
    if (rule !== undefined && autoAcceptClears(rule, submission.proposal)) {
      void this.accept(id);
    }
    return id;
  }

  /** Accept a proposal: yield, then (unless cancelled) commit it as tagged
   * deltas through the one write path. */
  async accept(id: string, signal?: AbortSignal): Promise<AcceptOutcome> {
    const held = this.held.get(id);
    if (held === undefined) return { ok: false, errors: ['unknown-proposal'] };
    if (isAborted(signal)) return { ok: false, errors: ['cancelled'] };

    this.commands.setProposalStatus(id, 'accepting');
    // Yield so the UI stays responsive; a cancellation can land in this window.
    await Promise.resolve();
    if (isAborted(signal)) {
      this.commands.setProposalStatus(id, 'pending');
      return { ok: false, errors: ['cancelled'] };
    }

    const store = this.graphStore();
    if (store === null) {
      const errors = ['no-open-corpus'];
      this.commands.setProposalStatus(id, 'failed', errors);
      return { ok: false, errors };
    }

    const result = applyProposal(store, held.proposal, {
      actor: `studio:ai-accept:${held.service}`,
    });
    if (result.ok) {
      // The graph-store subscription in StudioSession replans and republishes the
      // model; the session then recomputes the AI-origin summary. Nothing else to do.
      this.held.delete(id);
      this.commands.removeProposal(id);
      return { ok: true, errors: [] };
    }
    const errors = result.errors.map((issue) => `[${issue.code}] ${issue.message}`);
    this.commands.setProposalStatus(id, 'failed', errors);
    return { ok: false, errors };
  }

  /** Reject a proposal: drop it. Rejection writes nothing (ADR-0031). */
  reject(id: string): void {
    if (!this.held.has(id)) return;
    this.held.delete(id);
    this.commands.removeProposal(id);
  }

  /** Set a service's auto-accept opt-in, then apply any now-eligible pending
   * proposals from that service. */
  setAutoAccept(service: string, rule: AutoAcceptRule): void {
    this.commands.setAutoAccept(service, rule);
    if (!rule.enabled) return;
    for (const [id, held] of this.held) {
      if (held.service !== service) continue;
      const descriptor = this.store.getState().ai.proposals.find((item) => item.id === id);
      if (descriptor?.status !== 'pending') continue;
      if (autoAcceptClears(rule, held.proposal)) void this.accept(id);
    }
  }

  /** Number of proposals still held (test/introspection seam). */
  pendingCount(): number {
    return this.held.size;
  }

  /** Drop all held proposals (new-corpus reset; the store slice is reset by
   * `beginOpen`). */
  clear(): void {
    this.held.clear();
  }

  private now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }
}
