/**
 * `StructureExtractor` / `extractStructure` (subphase 8E — the P9 enabler):
 * turn a span of unstructured text into a small typed graph (nodes + edges)
 * as a *proposal*, never a write. The gateway validates the model's output
 * against {@link extractedStructureSchema} (one repair, then typed rejection),
 * so a shape-invalid response can never reach the graph (ADR-0031). This
 * service adds the second validation the schema can't express — referential
 * integrity: every edge must reference node ids the model actually emitted —
 * and drops the danglers, reporting the count.
 *
 * Provenance is stamped by the service, never asked of the model (ADR-0031):
 * a successful extraction carries the reproducible call's quartet so the P9
 * adapter that applies it can stamp `origin:'ai'` on the resulting elements.
 *
 * Partial/budget/error semantics mirror {@link summarizeCut} at unit-of-one
 * granularity (ADR-0032): a budget trip or a degradable model failure yields
 * an *empty, valid* proposal (nothing extracted) rather than throwing, so the
 * caller always gets a well-formed result; only a genuine setup/consistency
 * fault (replay miss, cancellation, bad config) propagates.
 */
import { type AiSession, type BudgetState } from '@meridian/ai';
import { classify } from './disposition.js';
import { EXTRACT_STRUCTURE_PROMPT } from './prompts/extract-structure.js';
import { type AiProvenance, provenanceOfCall } from './provenance.js';
import type { ProposedEdge, ProposedNode } from './schemas.js';

/** What the caller knows about the domain the text should be extracted under. */
export interface DomainHints {
  /** Namespace for emitted node/kind ids (e.g. `arg`). */
  readonly domain: string;
}

/**
 * A validated graph proposal: nodes + typed edges with referential integrity
 * (every edge references an emitted node) and, when AI produced it, the
 * reproducible call's provenance. Deterministic-floor results (budget/refusal)
 * are empty and carry no provenance.
 */
export interface GraphProposal {
  readonly nodes: readonly ProposedNode[];
  readonly edges: readonly ProposedEdge[];
  /** The reproducible call that produced a non-empty extraction (ADR-0031). */
  readonly provenance?: AiProvenance;
}

export interface ExtractStructureOptions {
  readonly signal?: AbortSignal;
}

export interface ExtractStructureResult {
  readonly proposal: GraphProposal;
  /** true = AI produced structure; false = empty floor (budget/refusal/empty text). */
  readonly extracted: boolean;
  /** Edges dropped for referencing an id no emitted node declared. */
  readonly droppedEdges: number;
  /** True iff the budget guard hard-stopped this extraction (ADR-0032). */
  readonly stoppedByBudget: boolean;
  readonly budget: BudgetState;
}

const EMPTY: GraphProposal = { nodes: [], edges: [] };

/**
 * Keep only edges whose `src` and `dst` are ids the node set declares, and drop
 * nodes with duplicate ids (first occurrence wins) so the proposal is a
 * well-formed graph. Returns the cleaned structure and how many edges were cut.
 */
function enforceReferentialIntegrity(
  nodes: readonly ProposedNode[],
  edges: readonly ProposedEdge[],
): { nodes: readonly ProposedNode[]; edges: readonly ProposedEdge[]; droppedEdges: number } {
  const seen = new Set<string>();
  const keptNodes: ProposedNode[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    keptNodes.push(node);
  }
  const keptEdges = edges.filter((e) => seen.has(e.src) && seen.has(e.dst));
  return { nodes: keptNodes, edges: keptEdges, droppedEdges: edges.length - keptEdges.length };
}

/**
 * Extract one graph proposal from `text`. Whitespace-only text short-circuits
 * to an empty proposal with no gateway call (no spend). See the module doc for
 * validation and partial/budget/error semantics.
 */
export async function extractStructure(
  session: AiSession,
  text: string,
  hints: DomainHints,
  options: ExtractStructureOptions = {},
): Promise<ExtractStructureResult> {
  if (text.trim().length === 0) {
    return { proposal: EMPTY, extracted: false, droppedEdges: 0, stoppedByBudget: false, budget: session.budget };
  }

  try {
    const res = await session.call(
      EXTRACT_STRUCTURE_PROMPT,
      { domain: hints.domain, text },
      { ...(options.signal !== undefined ? { signal: options.signal } : {}) },
    );
    const { nodes, edges, droppedEdges } = enforceReferentialIntegrity(res.value.nodes, res.value.edges);
    return {
      proposal: { nodes, edges, provenance: provenanceOfCall(res) },
      extracted: true,
      droppedEdges,
      stoppedByBudget: false,
      budget: session.budget,
    };
  } catch (error) {
    const disposition = classify(error);
    if (disposition === 'propagate') throw error;
    return {
      proposal: EMPTY,
      extracted: false,
      droppedEdges: 0,
      stoppedByBudget: disposition === 'stop-budget',
      budget: session.budget,
    };
  }
}

/** The P2/P9 seam: extract a validated {@link GraphProposal} from text. */
export interface StructureExtractor {
  extract(text: string, hints: DomainHints): Promise<GraphProposal>;
}

export interface StructureExtractorOptions extends ExtractStructureOptions {
  /** Domain used when `extract` is called without per-call hints. */
  readonly domain?: string;
}

/**
 * Wrap a session as a reusable {@link StructureExtractor}. `extract` discards
 * the report and returns just the validated proposal; use {@link
 * extractStructure} directly when the caller needs the budget/dropped report.
 */
export function createStructureExtractor(
  session: AiSession,
  options: StructureExtractorOptions = {},
): StructureExtractor {
  return {
    extract: async (text, hints) => (await extractStructure(session, text, hints, options)).proposal,
  };
}
