/**
 * `SummarizingAbstractionProvider` (subphase 8D): the first real AI service.
 * It implements the existing P3 `AbstractionProvider` seam and is a *decorator*
 * — a deterministic base provider decides the grouping (its membership is the
 * deterministic floor, §8.1.1), and this service replaces each group's
 * statistical label with an AI name + summary, tagging the group with the
 * ADR-0031 provenance quartet so acceptance stamps it on the cluster node's
 * `SourceRef`. AI never picks members and never writes: it only enriches
 * proposals that then flow through the one write path (ADR-0005/0031).
 *
 * Keeping the grouping in the injected base means "AI unavailable" degrades to
 * exactly the deterministic proposal — the provider still returns valid groups.
 */
import type { AiSession } from '@meridian/ai';
import type { GraphDocument } from '@meridian/graph-core';
import type {
  AbstractionContext,
  AbstractionProposal,
  AbstractionProvider,
  ProposedGroup,
} from '@meridian/plugin-api';
import type { MemberDigest } from './prompts/summarize-rollup.js';
import { type RollupInput, type RollupSummary, summarizeCut, type SummarizeCutResult } from './summarize.js';

export interface SummarizingProviderOptions {
  readonly session: AiSession;
  /** Deterministic grouping source (e.g. the containment-rollup provider). */
  readonly base: AbstractionProvider;
  /** This provider's capability id. Defaults to `core:summarizing-rollup`. */
  readonly id?: string;
  readonly signal?: AbortSignal;
  /** Cap on member digests rendered per rollup. Default 40. */
  readonly maxMembersPerRollup?: number;
}

export const SUMMARIZING_ROLLUP_ID = 'core:summarizing-rollup';

/** Node facts indexed by id, gathered once from the document. */
interface NodeFacts {
  readonly kind: string;
  readonly label: string;
  readonly domain: string;
}

function indexNodes(doc: GraphDocument): ReadonlyMap<string, NodeFacts> {
  const index = new Map<string, NodeFacts>();
  for (const graph of doc.graphs) {
    const domain = graph.meta.domain;
    for (const node of graph.nodes) index.set(node.id, { kind: node.kind, label: node.label, domain });
  }
  return index;
}

/** A stable digest of a group's members (sorted by kind, then label, then id). */
function digestOf(group: ProposedGroup, nodes: ReadonlyMap<string, NodeFacts>): {
  readonly digest: readonly MemberDigest[];
  readonly domain: string;
} {
  const entries = group.members.map((id) => {
    const facts = nodes.get(id);
    return { id, kind: facts?.kind ?? 'core:node', label: facts?.label ?? id, domain: facts?.domain ?? 'core' };
  });
  entries.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.label, b.label) || cmp(a.id, b.id));
  const domain = entries[0]?.domain ?? 'core';
  return { digest: entries.map((e) => ({ kind: e.kind, label: e.label })), domain };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Build the summarizer's input for one group, with a deterministic floor. */
export function rollupOf(group: ProposedGroup, nodes: ReadonlyMap<string, NodeFacts>): RollupInput {
  const { digest, domain } = digestOf(group, nodes);
  const kinds = [...new Set(digest.map((d) => d.kind))].sort();
  const fallbackSummary =
    group.rationale.length > 0
      ? group.rationale
      : `${group.members.length} related ${domain} items (kinds: ${kinds.join(', ')}).`;
  return {
    id: group.id,
    domain,
    members: group.members,
    digest,
    fallbackName: group.label,
    fallbackSummary,
  };
}

/** Fold an AI summary back into its group; floored groups pass through as the
 * deterministic proposal (no AI fields ⇒ acceptance keeps `origin:'derived'`). */
function enrich(group: ProposedGroup, summary: RollupSummary): ProposedGroup {
  if (!summary.enriched || summary.provenance === undefined) return group;
  const p = summary.provenance;
  return {
    ...group,
    label: summary.name,
    confidence: summary.confidence,
    summary: summary.summary,
    providerId: p.providerId,
    model: p.model,
    promptVersion: p.promptVersion,
    inputHash: p.inputHash,
  };
}

/**
 * Run the base grouping, then AI-enrich each group's name/summary. Returns both
 * the enriched proposal (ready for `applyProposal`) and the {@link
 * SummarizeCutResult} report so callers (the CLI) can show the enriched/floored
 * boundary and budget spend.
 */
export async function summarizeAbstraction(
  options: SummarizingProviderOptions,
  doc: GraphDocument,
  ctx: AbstractionContext,
): Promise<{ proposal: AbstractionProposal; report: SummarizeCutResult }> {
  const base = await options.base.propose(doc, ctx);
  const nodes = indexNodes(doc);
  const rollups = base.groups.map((g) => rollupOf(g, nodes));
  const report = await summarizeCut(options.session, rollups, {
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.maxMembersPerRollup !== undefined
      ? { maxMembersPerRollup: options.maxMembersPerRollup }
      : {}),
  });
  const byId = new Map(report.summaries.map((s) => [s.id, s]));
  const groups = base.groups.map((g) => {
    const summary = byId.get(g.id);
    return summary ? enrich(g, summary) : g;
  });
  return { proposal: { groups }, report };
}

/** The `AbstractionProvider` seam wrapper — discards the report for the seam. */
export function createSummarizingProvider(options: SummarizingProviderOptions): AbstractionProvider {
  return {
    id: options.id ?? SUMMARIZING_ROLLUP_ID,
    propose: async (doc, ctx) => (await summarizeAbstraction(options, doc, ctx)).proposal,
  };
}

/**
 * The named `AbstractionProvider` implementation the roadmap commits to (§5) —
 * a class facade over {@link summarizeAbstraction}. `propose` satisfies the P3
 * seam (report discarded); {@link SummarizingAbstractionProvider.summarize}
 * exposes the full {@link SummarizeCutResult} for callers (the CLI) that render
 * the enriched/floored boundary and budget spend.
 */
export class SummarizingAbstractionProvider implements AbstractionProvider {
  readonly id: string;

  constructor(private readonly options: SummarizingProviderOptions) {
    this.id = options.id ?? SUMMARIZING_ROLLUP_ID;
  }

  propose(doc: GraphDocument, ctx: AbstractionContext): Promise<AbstractionProposal> {
    return summarizeAbstraction(this.options, doc, ctx).then((r) => r.proposal);
  }

  summarize(
    doc: GraphDocument,
    ctx: AbstractionContext,
  ): Promise<{ proposal: AbstractionProposal; report: SummarizeCutResult }> {
    return summarizeAbstraction(this.options, doc, ctx);
  }
}
