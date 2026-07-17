/**
 * `meridian ai enrich` — the Phase 9C enrichment pass for the conversation
 * domain, living in the application composition root exactly where ADR-0034
 * puts it: the adapter package stays skeleton-only (deterministic, AI-free),
 * and this command reads the *accepted* skeleton, invokes the provider-neutral
 * `ai-services` through the Phase 8 gateway, and turns the results into
 * ordinary atomic deltas through the store's one write path (ADR-0005/0031).
 *
 * Domains (dispatched by the document's graphs):
 * - **conversation** (9C) — the topic + claim passes below.
 * - **argument** (9D) — per-paragraph argument-map extraction: `extractStructure`
 *   over each paragraph yields typed `arg:thesis|claim|premise|objection|evidence`
 *   nodes placed in the paragraphs graph, each anchored to its source paragraph
 *   with an `arg:cites` evidence edge, plus the model's intra-extraction
 *   `arg:supports|rebuts|assumes|cites` relations. The skeleton stays the
 *   AI-less floor (§7.3: maximal enrichment reliance over a sentence floor).
 *
 * Two separately-cacheable conversation passes (§7.2 step 4):
 * - **Topics** — each session's exchanges are embedding-clustered (8E) and each
 *   cluster is AI-named/summarized (8D); the groups materialize through
 *   `applyProposal` as `conv:topic` nodes whose detail graphs hold the grouped
 *   exchanges, so the level chain deepens session → topic → exchange → message.
 * - **Claims** — each message's text goes through `extractStructure` (8E); the
 *   extracted `conv:claim` nodes are anchored to the message with `conv:about`
 *   edges (plus `conv:refers-back` between claims), inside the message's graph.
 *
 * Idempotent merge (ADR-0034): enriched elements are keyed by stable skeleton
 * coordinates and carry the ADR-0030 quartet; a re-run whose `inputHash`
 * matches what the graph already holds is a **no-op**, a changed enrichment
 * **replaces** the prior derived structure, and identity never includes model
 * or provenance (ADR-0002). Failure never touches the skeleton: a budget trip
 * or degradable provider failure floors that unit and the graph stays complete
 * and valid, just less enriched (ADR-0032).
 */
import { writeFile } from 'node:fs/promises';
import {
  decode,
  deriveEdgeId,
  deriveNodeId,
  encodePretty,
  type GraphId,
  type GraphSpace,
  type SemanticEdge,
  type SemanticGraph,
  type SemanticNode,
  type SourceRef,
} from '@meridian/graph-core';
import { createStore, type GraphOpInput, type GraphStore } from '@meridian/graph-store';
import { applyProposal } from '@meridian/abstraction';
import type { ProposedGroup } from '@meridian/plugin-api';
import type { AiSession } from '@meridian/ai';
import { stderrLine, stdoutLine } from './io.js';
import {
  classify,
  clusterNodes,
  extractStructure,
  type ClusterNodeInput,
  type RollupInput,
  summarizeCut,
} from '@meridian/ai-services';
import {
  AiCliError,
  type AiCommandOptions,
  type BuiltSession,
  buildSessionFor,
  persistFixtures,
  reportError,
} from './ai.js';

const DOMAIN = 'conversation';
const ARG_DOMAIN = 'argument';
const ARG_MAP_KINDS: ReadonlySet<string> = new Set([
  'arg:thesis',
  'arg:claim',
  'arg:premise',
  'arg:objection',
  'arg:evidence',
]);
const ARG_REL_KINDS: ReadonlySet<string> = new Set(['arg:supports', 'arg:rebuts', 'arg:assumes', 'arg:cites']);
const ACTOR = 'ai:enrich';
const PRODUCER = { name: '@meridian/cli', version: '0.1.0' };
/** Prompt-size guard on an exchange's embedded/extracted digest. */
const DIGEST_CAP = 2000;

export interface EnrichCommandOptions extends AiCommandOptions {
  /** Write the enriched document here (omit = dry run, report only). */
  readonly out?: string;
}

function out(line: string): void {
  stdoutLine(line);
}

function err(line: string): void {
  stderrLine(line);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Nodes in deterministic skeleton order: `conv:index` ascending (nodes
 * without one — e.g. claims — sort after), id ties. The comparator is a
 * consistent total order; mixing per-pair rules would let the sort shuffle. */
function sortedNodes(graph: SemanticGraph): SemanticNode[] {
  const indexOf = (n: SemanticNode): number => {
    const i = n.attrs['conv:index'] ?? n.attrs['arg:index'];
    return typeof i === 'number' ? i : Number.MAX_SAFE_INTEGER;
  };
  return [...graph.nodes.values()].sort((a, b) => {
    const ai = indexOf(a);
    const bi = indexOf(b);
    if (ai !== bi) return ai < bi ? -1 : 1;
    return cmp(a.id, b.id);
  });
}

function sortedEdges(graph: SemanticGraph): SemanticEdge[] {
  return [...graph.edges.values()].sort((a, b) => cmp(a.id, b.id));
}

// ------------------------------------------------------------------- topics

interface ExchangeEntry {
  readonly node: SemanticNode;
  /** Message text of the exchange, in skeleton order — what gets embedded. */
  readonly digest: string;
}

interface TopicStats {
  sessions: number;
  layered: number;
  unchanged: number;
  replaced: number;
  floored: number;
}

/** The exchange's message text, in order, capped for prompt size. */
function exchangeDigest(space: GraphSpace, exchange: SemanticNode): string {
  if (exchange.detail === undefined) return exchange.label;
  const detail = space.graphs.get(exchange.detail.graph);
  if (detail === undefined) return exchange.label;
  const text = sortedNodes(detail)
    .filter((n) => n.kind === 'conv:message')
    .map((n) => n.label)
    .join('\n');
  return text.slice(0, DIGEST_CAP);
}

/**
 * Every exchange under a session graph, looking *through* an existing 9C topic
 * layer (so a re-run clusters the same exchange set it clustered before), plus
 * the AI topic nodes currently layering this session.
 */
function collectExchanges(
  space: GraphSpace,
  graph: SemanticGraph,
): { exchanges: ExchangeEntry[]; topics: SemanticNode[] } {
  const exchanges: ExchangeEntry[] = [];
  const topics: SemanticNode[] = [];
  for (const node of sortedNodes(graph)) {
    if (node.kind === 'conv:exchange') {
      exchanges.push({ node, digest: exchangeDigest(space, node) });
    } else if (node.kind === 'conv:topic' && node.provenance.origin === 'ai' && node.detail !== undefined) {
      topics.push(node);
      const detail = space.graphs.get(node.detail.graph);
      if (detail !== undefined) exchanges.push(...collectExchanges(space, detail).exchanges);
    }
  }
  return { exchanges, topics };
}

/** Session detail graphs (the graphs holding exchanges), sorted for stable
 * call order — the same document must render the same gateway-call sequence
 * every run (ADR-0030 replay). */
function sessionGraphIds(space: GraphSpace): GraphId[] {
  const ids: GraphId[] = [];
  for (const graph of space.graphs.values()) {
    if (graph.meta.domain !== DOMAIN) continue;
    for (const node of graph.nodes.values()) {
      if (node.kind === 'conv:session' && node.detail !== undefined) ids.push(node.detail.graph);
    }
  }
  return ids.sort(cmp);
}

/** Dissolve an existing topic layer: members move back to the session graph,
 * the topic nodes and their detail graphs go away — one atomic delta. The
 * subsequent regroup is a second delta; if it fails, the graph is still the
 * valid (merely un-layered) skeleton, per ADR-0032. */
function ungroupTopics(store: GraphStore, sessionGraph: GraphId, topics: readonly SemanticNode[]): void {
  const space = store.snapshot();
  const ops: GraphOpInput[] = [];
  for (const topic of [...topics].sort((a, b) => cmp(a.id, b.id))) {
    ops.push({ t: 'node:remove', graph: sessionGraph, id: topic.id, prev: topic });
    const detailId = topic.detail?.graph;
    const detail = detailId !== undefined ? space.graphs.get(detailId) : undefined;
    if (detailId === undefined || detail === undefined) continue;
    for (const edge of sortedEdges(detail)) ops.push({ t: 'edge:remove', graph: detailId, id: edge.id, prev: edge });
    for (const node of sortedNodes(detail)) {
      ops.push({ t: 'node:remove', graph: detailId, id: node.id, prev: node });
      ops.push({ t: 'node:add', graph: sessionGraph, node });
    }
    for (const edge of sortedEdges(detail)) ops.push({ t: 'edge:add', graph: sessionGraph, edge });
    ops.push({ t: 'graph:remove', graph: detailId, prev: detail.meta });
  }
  const r = store.apply({ origin: { actor: ACTOR }, ops });
  if (!r.ok) {
    throw new AiCliError(1, `ai enrich: ungroup rejected: ${r.errors.map((e) => `[${e.code}] ${e.message}`).join('; ')}`);
  }
}

/** The topic pass (see module doc). */
async function enrichTopics(store: GraphStore, session: AiSession): Promise<TopicStats> {
  const stats: TopicStats = { sessions: 0, layered: 0, unchanged: 0, replaced: 0, floored: 0 };
  for (const graphId of sessionGraphIds(store.snapshot())) {
    const space = store.snapshot();
    const graph = space.graphs.get(graphId);
    if (graph === undefined) continue;
    stats.sessions += 1;

    const { exchanges, topics } = collectExchanges(space, graph);
    if (exchanges.length < 2) continue; // nothing to layer over

    const inputs: ClusterNodeInput[] = exchanges.map((e) => ({
      id: e.node.id,
      text: e.digest,
      kind: 'conv:exchange',
      label: e.node.label,
    }));
    const digestById = new Map(inputs.map((i) => [i.id, i.text]));

    let clusters;
    try {
      clusters = (await clusterNodes(session, inputs, { domain: DOMAIN })).clusters;
    } catch (error) {
      if (classify(error) === 'propagate') throw error;
      stats.floored += 1; // budget/degradable failure: the skeleton stands (ADR-0032)
      continue;
    }
    if (clusters.length === 0) {
      stats.floored += 1;
      continue;
    }

    const rollups: RollupInput[] = clusters.map((c) => ({
      id: c.id,
      domain: DOMAIN,
      members: c.members,
      digest: c.members.map((m) => ({ kind: 'conv:exchange', label: (digestById.get(m) ?? '').slice(0, 160) })),
      fallbackName: c.label,
      fallbackSummary: `${c.members.length} exchange${c.members.length === 1 ? '' : 's'}`,
    }));
    const { summaries } = await summarizeCut(session, rollups);
    const summaryById = new Map(summaries.map((s) => [s.id, s]));

    const groups: ProposedGroup[] = clusters.map((c) => {
      const s = summaryById.get(c.id)!;
      const prov = s.provenance ?? c.provenance;
      return {
        id: c.id,
        label: s.name,
        members: c.members,
        rationale: 'embedding-clustered conversation topic (9C)',
        confidence: s.enriched ? s.confidence : c.confidence,
        summary: s.summary,
        kind: 'conv:topic',
        providerId: prov.providerId,
        model: prov.model,
        promptVersion: prov.promptVersion,
        inputHash: prov.inputHash,
      };
    });

    // Idempotent merge (ADR-0034): identical layer (same group ids, same
    // inputHash) ⇒ no-op; anything else replaces the prior layer wholesale.
    const existing = new Map(topics.map((t) => [t.id as string, t.provenance.inputHash]));
    const identical =
      groups.length === existing.size && groups.every((g) => existing.get(g.id) === g.inputHash);
    if (identical) {
      stats.unchanged += 1;
      continue;
    }

    if (topics.length > 0) ungroupTopics(store, graphId, topics);
    const applied = applyProposal(store, { groups }, { actor: ACTOR });
    if (!applied.ok) {
      throw new AiCliError(
        1,
        `ai enrich: topic proposal rejected: ${applied.errors.map((e) => `[${e.code}] ${e.message}`).join('; ')}`,
      );
    }
    stats[topics.length > 0 ? 'replaced' : 'layered'] += 1;
  }
  return stats;
}

// ------------------------------------------------------------------- claims

interface ClaimStats {
  messages: number;
  added: number;
  unchanged: number;
  replaced: number;
  floored: number;
}

/** The claim pass (see module doc). All changes commit as one atomic delta. */
async function enrichClaims(store: GraphStore, session: AiSession): Promise<ClaimStats> {
  const stats: ClaimStats = { messages: 0, added: 0, unchanged: 0, replaced: 0, floored: 0 };
  const space = store.snapshot();
  const ops: GraphOpInput[] = [];

  for (const graphId of [...space.graphs.keys()].sort(cmp)) {
    const graph = space.graphs.get(graphId)!;
    if (graph.meta.domain !== DOMAIN) continue;
    const messages = sortedNodes(graph).filter((n) => n.kind === 'conv:message');
    if (messages.length === 0) continue;

    // Existing AI claims, anchored to their message via the conv:about edge.
    const claimNodes = new Map<string, SemanticNode>();
    for (const n of graph.nodes.values()) {
      if (n.kind === 'conv:claim' && n.provenance.origin === 'ai') claimNodes.set(n.id, n);
    }
    const claimsByMessage = new Map<string, SemanticNode[]>();
    for (const e of sortedEdges(graph)) {
      if (e.kind !== 'conv:about') continue;
      const claim = claimNodes.get(e.src);
      if (claim === undefined) continue;
      const list = claimsByMessage.get(e.dst) ?? [];
      list.push(claim);
      claimsByMessage.set(e.dst, list);
    }

    for (const message of messages) {
      stats.messages += 1;
      const res = await extractStructure(session, message.label, { domain: 'conv' });
      if (!res.extracted) {
        stats.floored += 1; // keep whatever accepted enrichment exists (ADR-0032)
        continue;
      }
      const prov = res.proposal.provenance;
      const existing = claimsByMessage.get(message.id) ?? [];
      const kept = res.proposal.nodes.filter((n) => n.kind === 'conv:claim');
      if (
        existing.length > 0
          ? existing.every((c) => c.provenance.inputHash === prov?.inputHash)
          : kept.length === 0
      ) {
        stats.unchanged += 1; // same call ⇒ same claims (or nothing to say, twice)
        continue;
      }

      // Replace: drop the prior claims (and every edge touching them) …
      const removedIds = new Set(existing.map((c) => c.id));
      if (removedIds.size > 0) {
        for (const e of sortedEdges(graph)) {
          if (removedIds.has(e.src) || removedIds.has(e.dst)) {
            ops.push({ t: 'edge:remove', graph: graphId, id: e.id, prev: e });
          }
        }
        for (const c of existing) ops.push({ t: 'node:remove', graph: graphId, id: c.id, prev: c });
      }

      // … then anchor the new ones to the message's stable coordinates.
      const provenance: SourceRef = {
        origin: 'ai',
        ...(prov !== undefined
          ? {
              providerId: prov.providerId,
              model: prov.model,
              promptVersion: prov.promptVersion,
              inputHash: prov.inputHash,
            }
          : {}),
      };
      const idMap = new Map<string, ReturnType<typeof deriveNodeId>>();
      for (const n of kept) {
        const nodeId = deriveNodeId({ domain: DOMAIN, source: message.id, path: ['claim', n.id] });
        idMap.set(n.id, nodeId);
        ops.push({
          t: 'node:add',
          graph: graphId,
          node: { id: nodeId, kind: 'conv:claim', label: n.label, attrs: {}, provenance },
        });
        ops.push({
          t: 'edge:add',
          graph: graphId,
          edge: {
            id: deriveEdgeId({ graph: graphId, kind: 'conv:about', src: nodeId, dst: message.id }),
            src: nodeId,
            dst: message.id,
            kind: 'conv:about',
            attrs: {},
            provenance,
          },
        });
      }
      for (const e of res.proposal.edges) {
        if (e.kind !== 'conv:refers-back') continue;
        const src = idMap.get(e.src);
        const dst = idMap.get(e.dst);
        if (src === undefined || dst === undefined || src === dst) continue;
        ops.push({
          t: 'edge:add',
          graph: graphId,
          edge: {
            id: deriveEdgeId({ graph: graphId, kind: 'conv:refers-back', src, dst }),
            src,
            dst,
            kind: 'conv:refers-back',
            attrs: {},
            provenance,
          },
        });
      }
      stats[existing.length > 0 ? 'replaced' : 'added'] += 1;
    }
  }

  if (ops.length > 0) {
    const r = store.apply({ origin: { actor: ACTOR }, ops });
    if (!r.ok) {
      throw new AiCliError(
        1,
        `ai enrich: claim delta rejected: ${r.errors.map((e) => `[${e.code}] ${e.message}`).join('; ')}`,
      );
    }
  }
  return stats;
}

// ----------------------------------------------------------------- argument

interface ArgMapStats {
  paragraphs: number;
  added: number;
  unchanged: number;
  replaced: number;
  floored: number;
}

/** The essay detail graphs (the graphs holding paragraph nodes), sorted for
 * a stable gateway-call sequence (ADR-0030 replay). */
function essayGraphIds(space: GraphSpace): GraphId[] {
  const ids: GraphId[] = [];
  for (const graph of space.graphs.values()) {
    if (graph.meta.domain !== ARG_DOMAIN) continue;
    for (const node of graph.nodes.values()) {
      if (node.kind === 'arg:essay' && node.detail !== undefined) ids.push(node.detail.graph);
    }
  }
  return ids.sort(cmp);
}

/**
 * The 9D argument-map pass (module doc). Extracted nodes live in the same
 * graph as their source paragraphs, so cross-paragraph relations stay legal
 * intra-graph edges when a later pass ever correlates them; v1 keeps only
 * relations within one extraction. All changes commit as one atomic delta.
 */
async function enrichArgumentMap(store: GraphStore, session: AiSession): Promise<ArgMapStats> {
  const stats: ArgMapStats = { paragraphs: 0, added: 0, unchanged: 0, replaced: 0, floored: 0 };
  const space = store.snapshot();
  const ops: GraphOpInput[] = [];

  for (const graphId of essayGraphIds(space)) {
    const graph = space.graphs.get(graphId);
    if (graph === undefined) continue;
    const paragraphs = sortedNodes(graph).filter((n) => n.kind === 'arg:paragraph');
    if (paragraphs.length === 0) continue;

    // Existing AI argument-map nodes, anchored to their paragraph via arg:cites.
    const mapNodes = new Map<string, SemanticNode>();
    for (const n of graph.nodes.values()) {
      if (ARG_MAP_KINDS.has(n.kind) && n.provenance.origin === 'ai') mapNodes.set(n.id, n);
    }
    const byParagraph = new Map<string, SemanticNode[]>();
    for (const e of sortedEdges(graph)) {
      if (e.kind !== 'arg:cites') continue;
      const node = mapNodes.get(e.src);
      const anchor = graph.nodes.get(e.dst);
      if (node === undefined || anchor === undefined || anchor.kind !== 'arg:paragraph') continue;
      const list = byParagraph.get(e.dst) ?? [];
      list.push(node);
      byParagraph.set(e.dst, list);
    }

    for (const paragraph of paragraphs) {
      stats.paragraphs += 1;
      const res = await extractStructure(session, paragraph.label, { domain: 'arg' });
      if (!res.extracted) {
        stats.floored += 1; // keep whatever accepted enrichment exists (ADR-0032)
        continue;
      }
      const prov = res.proposal.provenance;
      const existing = byParagraph.get(paragraph.id) ?? [];
      const kept = res.proposal.nodes.filter((n) => ARG_MAP_KINDS.has(n.kind));
      if (
        existing.length > 0
          ? existing.every((c) => c.provenance.inputHash === prov?.inputHash)
          : kept.length === 0
      ) {
        stats.unchanged += 1;
        continue;
      }

      const removedIds = new Set(existing.map((c) => c.id));
      if (removedIds.size > 0) {
        for (const e of sortedEdges(graph)) {
          if (removedIds.has(e.src) || removedIds.has(e.dst)) {
            ops.push({ t: 'edge:remove', graph: graphId, id: e.id, prev: e });
          }
        }
        for (const c of existing) ops.push({ t: 'node:remove', graph: graphId, id: c.id, prev: c });
      }

      const provenance: SourceRef = {
        origin: 'ai',
        ...(prov !== undefined
          ? {
              providerId: prov.providerId,
              model: prov.model,
              promptVersion: prov.promptVersion,
              inputHash: prov.inputHash,
            }
          : {}),
      };
      const idMap = new Map<string, ReturnType<typeof deriveNodeId>>();
      for (const n of kept) {
        const nodeId = deriveNodeId({ domain: ARG_DOMAIN, source: paragraph.id, path: ['arg', n.id] });
        idMap.set(n.id, nodeId);
        ops.push({
          t: 'node:add',
          graph: graphId,
          node: { id: nodeId, kind: n.kind, label: n.label, attrs: {}, provenance },
        });
        // The evidence anchor: the extracted structure cites its source paragraph.
        ops.push({
          t: 'edge:add',
          graph: graphId,
          edge: {
            id: deriveEdgeId({ graph: graphId, kind: 'arg:cites', src: nodeId, dst: paragraph.id }),
            src: nodeId,
            dst: paragraph.id,
            kind: 'arg:cites',
            attrs: {},
            provenance,
          },
        });
      }
      for (const e of res.proposal.edges) {
        if (!ARG_REL_KINDS.has(e.kind)) continue;
        const src = idMap.get(e.src);
        const dst = idMap.get(e.dst);
        if (src === undefined || dst === undefined || src === dst) continue;
        ops.push({
          t: 'edge:add',
          graph: graphId,
          edge: {
            id: deriveEdgeId({ graph: graphId, kind: e.kind, src, dst }),
            src,
            dst,
            kind: e.kind,
            attrs: {},
            provenance,
          },
        });
      }
      stats[existing.length > 0 ? 'replaced' : 'added'] += 1;
    }
  }

  if (ops.length > 0) {
    const r = store.apply({ origin: { actor: ACTOR }, ops });
    if (!r.ok) {
      throw new AiCliError(
        1,
        `ai enrich: argument-map delta rejected: ${r.errors.map((e) => `[${e.code}] ${e.message}`).join('; ')}`,
      );
    }
  }
  return stats;
}

// ------------------------------------------------------------------ command

export async function cmdAiEnrich(file: string, text: string, opts: EnrichCommandOptions): Promise<number> {
  const decoded = decode(text);
  if (!decoded.ok) {
    out(`INVALID ${file}`);
    for (const e of decoded.errors) out(`  [${e.code}] ${e.message}`);
    return 1;
  }
  const domains = new Set([...decoded.space.graphs.values()].map((g) => g.meta.domain));
  const hasConversation = domains.has(DOMAIN);
  const hasArgument = domains.has(ARG_DOMAIN);
  if (!hasConversation && !hasArgument) {
    err(`ai enrich: ${file} has no conversation- or argument-domain graphs (the two AI-native domains, Phase 9)`);
    return 2;
  }

  let built: BuiltSession;
  try {
    built = await buildSessionFor(['summarization', 'extraction', 'embedding'], opts);
  } catch (error) {
    return reportError(error);
  }

  const store = createStore(decoded.space);
  try {
    const topics = hasConversation ? await enrichTopics(store, built.session) : undefined;
    const claims = hasConversation ? await enrichClaims(store, built.session) : undefined;
    const argmap = hasArgument ? await enrichArgumentMap(store, built.session) : undefined;

    if (built.mode === 'record' && opts.fixtures !== undefined) {
      await persistFixtures(built, opts.fixtures);
    }
    if (opts.out !== undefined) {
      await writeFile(opts.out, encodePretty(store.snapshot(), { producer: PRODUCER }), 'utf8');
    }

    const budget = built.session.budget;
    if (opts.json) {
      out(
        JSON.stringify(
          {
            file,
            command: 'enrich',
            domain: hasConversation && hasArgument ? 'conversation+argument' : hasConversation ? DOMAIN : ARG_DOMAIN,
            mode: built.mode,
            provider: built.providerId,
            model: built.model,
            ...(topics !== undefined ? { topics } : {}),
            ...(claims !== undefined ? { claims } : {}),
            ...(argmap !== undefined ? { argmap } : {}),
            budget,
            ...(opts.out !== undefined ? { out: opts.out } : {}),
          },
          null,
          2,
        ),
      );
      return 0;
    }

    out(`OK ${file} — enrich (mode=${built.mode}, provider=${built.providerId}, model=${built.model})`);
    if (topics !== undefined) {
      out(
        `  topics: sessions ${topics.sessions} · layered ${topics.layered} · unchanged ${topics.unchanged}` +
          ` · replaced ${topics.replaced} · floored ${topics.floored}`,
      );
    }
    if (claims !== undefined) {
      out(
        `  claims: messages ${claims.messages} · added ${claims.added} · unchanged ${claims.unchanged}` +
          ` · replaced ${claims.replaced} · floored ${claims.floored}`,
      );
    }
    if (argmap !== undefined) {
      out(
        `  argmap: paragraphs ${argmap.paragraphs} · added ${argmap.added} · unchanged ${argmap.unchanged}` +
          ` · replaced ${argmap.replaced} · floored ${argmap.floored}`,
      );
    }
    out(
      `  budget: $${budget.spentDollars.toFixed(6)} · ${budget.spentTokens} tokens · ${budget.calls} calls`,
    );
    if (opts.out !== undefined) out(`  wrote ${opts.out}`);
    return 0;
  } catch (error) {
    return reportError(error);
  }
}
