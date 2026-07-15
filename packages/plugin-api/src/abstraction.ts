/**
 * The `abstraction-provider` capability (ARCHITECTURE.md §5.2, §8.1; roadmap
 * Phase 3 §5). A provider proposes grouping over a graph that has little or
 * no containment — turning a flat region into hierarchy (§3.1 Cluster).
 * Deterministic implementations (containment rollup, degree/size collapse)
 * arrive in Phase 3D; AI-backed ones in Phase 8. This file is *types only*:
 * the enum entry `abstraction-provider` already exists (ADR-0011); Phase 3B
 * lands the contract shape, no host wiring.
 *
 * Everything here crosses the plugin boundary, so it is structured-clone-safe
 * (ADR-0009) and speaks the IR (`GraphDocument`, §6.1) — never the core's
 * in-memory `SemanticGraph`. Proposals are *suggestions*: they become
 * ordinary provenance-tagged deltas through the one write path (P2, §8.1),
 * never a second write channel.
 */
import type { AttrValue, GraphDocument } from '@meridian/graph-core';
import type { PluginLogger } from './context.js';

/** One proposed group node and the members to be placed under its detail
 * graph. `id` is a deterministic group-node id (ADR-0002); `confidence` is
 * set by AI providers (§8.1), omitted by deterministic ones.
 *
 * The optional fields below are additive carriers for AI-backed providers
 * (P8, ADR-0031); deterministic providers omit them, so their proposals are
 * byte-identical to before. `summary` is the rollup node's generated prose;
 * `attrs` are extra namespaced attributes to stamp on the group node (e.g.
 * `ai:*`); the provenance quartet (`providerId`, `model`, `promptVersion`,
 * `inputHash`) is the ADR-0030 replay key that {@link applyProposal} records
 * on the group node's `SourceRef` so it names the reproducible call. */
export interface ProposedGroup {
  readonly id: string;
  readonly label: string;
  readonly members: readonly string[];
  readonly rationale: string;
  readonly confidence?: number;
  /** Namespaced node kind for the group node (Phase 9C, ADR-0034 — domains
   * type their enrichment layers, e.g. `conv:topic`). Must be a kind the
   * domain's manifest declares. Omitted = `core:cluster`, byte-identical to
   * every pre-9C proposal. Type-only additive field: no runtime surface
   * change, no version bump (ADR-0010). */
  readonly kind?: string;
  /** AI-generated one-line summary for the rollup node (§8.4). */
  readonly summary?: string;
  /** Extra namespaced attributes to attach to the group node (e.g. `ai:*`). */
  readonly attrs?: Readonly<Record<string, AttrValue>>;
  /** Routed provider adapter id — AI provenance replay key (ADR-0030/0031). */
  readonly providerId?: string;
  /** Routed model id — AI provenance replay key. */
  readonly model?: string;
  /** `PromptSpec` version — AI provenance replay key. */
  readonly promptVersion?: string;
  /** Canonical hash of the rendered request — AI provenance replay key. */
  readonly inputHash?: string;
}

/** A provider's output: a set of proposed groupings, nothing applied yet. */
export interface AbstractionProposal {
  readonly groups: readonly ProposedGroup[];
}

/** Injected, capability-scoped — no store reference, no ambient authority
 * (ADR-0009). `budget.maxGroups` caps how many groups a provider should
 * emit; the resolver's node budget (ADR-0014) is a separate, later concern. */
export interface AbstractionContext {
  readonly apiVersion: string;
  readonly log: PluginLogger;
  readonly budget?: { readonly maxGroups?: number };
}

export interface AbstractionProvider {
  /** Matches this provider's manifest capability `id`. */
  readonly id: string;
  /** Pure w.r.t. its inputs for deterministic providers; AI ones are
   * deterministic only under the record/replay cache (§8.3, I6). */
  propose(graph: GraphDocument, ctx: AbstractionContext): Promise<AbstractionProposal>;
}
