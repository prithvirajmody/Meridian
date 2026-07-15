/**
 * `applyProposal` (ROADMAP Phase 3 §6): turn an {@link AbstractionProposal}
 * into ordinary op-based P1 deltas and commit them through the store's **one
 * write path** (`store.apply`) — AI and deterministic providers alike get no
 * second write channel (§8.1, ADR-0005). Each proposed group becomes a new
 * node in the members' graph — `core:cluster` by default, or the group's
 * declared `kind` (Phase 9C: domains type their enrichment layers, e.g.
 * `conv:topic`) — whose detail graph holds the grouped nodes, so the new
 * containment is immediately visible to a subsequent cut.
 *
 * The transform relocates each member (and the edges *internal* to a group)
 * into the new detail graph. Because base edges are intra-graph (U1) and v1 has
 * no portals (§4.3, deferred), a group whose members have edges to non-members
 * cannot be expressed without cross-graph edges; such a proposal is **refused
 * up front with a located error**, never half-applied. All groups commit as one
 * atomic delta (or none do).
 *
 * Pure w.r.t. the snapshot except for the single `store.apply` call at the end;
 * imports graph-core + graph-store only (§20).
 */
import {
  asNodeId,
  type AttrValue,
  deriveGraphId,
  type GraphId,
  type GraphMeta,
  type GraphSpace,
  type NodeId,
  type SemanticEdge,
  type SemanticNode,
  type SourceRef,
} from '@meridian/graph-core';
import type { ChangeSet, GraphDelta, GraphOpInput, GraphStore } from '@meridian/graph-store';
import type { AbstractionProposal, ProposedGroup } from './providers.js';

/** A located reason a proposal could not be applied (before any write). */
export interface ProposalIssue {
  readonly code:
    | 'empty-group'
    | 'unknown-member'
    | 'members-span-graphs'
    | 'member-reused'
    | 'id-collision'
    | 'crosses-boundary'
    | 'store-rejected';
  readonly message: string;
  /** The offending group id, when the issue is group-scoped. */
  readonly group?: string;
}

export type ApplyProposalResult =
  | { readonly ok: true; readonly delta: GraphDelta; readonly changes: ChangeSet }
  | { readonly ok: false; readonly errors: readonly ProposalIssue[] };

export interface ApplyProposalOptions {
  /** History actor for the delta origin (§3.1). Defaults to `core:abstraction`. */
  readonly actor?: string;
}

interface PlannedGroup {
  readonly group: ProposedGroup;
  readonly parentGraph: GraphId;
  readonly detailGraph: GraphId;
  readonly memberNodes: readonly SemanticNode[];
  readonly internalEdges: readonly SemanticEdge[];
  readonly provenance: SourceRef;
}

function indexNodes(space: GraphSpace): Map<string, GraphId> {
  const nodeGraph = new Map<string, GraphId>();
  for (const graph of space.graphs.values()) {
    for (const id of graph.nodes.keys()) nodeGraph.set(id, graph.id);
  }
  return nodeGraph;
}

function usedIds(space: GraphSpace): Set<string> {
  const used = new Set<string>();
  for (const graph of space.graphs.values()) {
    used.add(graph.id);
    for (const id of graph.nodes.keys()) used.add(id);
    for (const id of graph.edges.keys()) used.add(id);
  }
  return used;
}

/**
 * The `SourceRef` a group's new nodes/graph carry. A group is AI-origin iff it
 * carries any AI signal (confidence or the ADR-0030 replay quartet); such a
 * group records `origin:'ai'` with every provenance field it supplied
 * (ADR-0031), so the cluster node names the reproducible call. Deterministic
 * proposals (no AI fields) stay `origin:'derived'`, byte-identical to before.
 */
function proposalProvenance(group: ProposedGroup): SourceRef {
  const isAi =
    group.confidence !== undefined ||
    group.providerId !== undefined ||
    group.model !== undefined ||
    group.promptVersion !== undefined ||
    group.inputHash !== undefined;
  if (!isAi) return { origin: 'derived' };
  return {
    origin: 'ai',
    ...(group.providerId !== undefined ? { providerId: group.providerId } : {}),
    ...(group.model !== undefined ? { model: group.model } : {}),
    ...(group.promptVersion !== undefined ? { promptVersion: group.promptVersion } : {}),
    ...(group.inputHash !== undefined ? { inputHash: group.inputHash } : {}),
    ...(group.confidence !== undefined ? { confidence: group.confidence } : {}),
  };
}

/**
 * The attributes stamped on a group's cluster node: the provider's `attrs`
 * verbatim, with `summary` mapped to `ai:summary` when present (an explicit
 * `ai:summary` in `attrs` wins). Deterministic groups carry neither, so their
 * node attrs stay `{}`.
 */
function proposalAttrs(group: ProposedGroup): Readonly<Record<string, AttrValue>> {
  const base: Record<string, AttrValue> = {};
  if (group.summary !== undefined) base['ai:summary'] = group.summary;
  return { ...base, ...(group.attrs ?? {}) };
}

/** Plan (validate + resolve) one group, or return its located issues. */
function planGroup(
  space: GraphSpace,
  group: ProposedGroup,
  nodeGraph: ReadonlyMap<string, GraphId>,
  claimed: Set<string>,
  used: Set<string>,
): { plan?: PlannedGroup; errors: ProposalIssue[] } {
  const errors: ProposalIssue[] = [];
  if (group.members.length === 0) {
    return { errors: [{ code: 'empty-group', message: `group "${group.id}" has no members`, group: group.id }] };
  }

  const memberSet = new Set(group.members);
  let parentGraph: GraphId | undefined;
  const memberNodes: SemanticNode[] = [];
  for (const m of group.members) {
    const g = nodeGraph.get(m);
    if (g === undefined) {
      errors.push({ code: 'unknown-member', message: `group "${group.id}": member "${m}" is not a node in the space`, group: group.id });
      continue;
    }
    if (parentGraph === undefined) parentGraph = g;
    else if (parentGraph !== g) {
      errors.push({ code: 'members-span-graphs', message: `group "${group.id}": members span graphs "${parentGraph}" and "${g}" — a group's members must share one graph`, group: group.id });
    }
    if (claimed.has(m)) {
      errors.push({ code: 'member-reused', message: `group "${group.id}": member "${m}" is already claimed by another group`, group: group.id });
    }
    const node = space.graphs.get(g)?.nodes.get(m as NodeId);
    if (node !== undefined) memberNodes.push(node);
  }
  if (used.has(group.id) || claimed.has(group.id)) {
    errors.push({ code: 'id-collision', message: `group "${group.id}": id is already used in the space`, group: group.id });
  }
  if (errors.length > 0 || parentGraph === undefined) return { errors };

  // Partition the parent graph's incident edges into internal vs. crossing.
  const parent = space.graphs.get(parentGraph)!;
  const internalEdges: SemanticEdge[] = [];
  for (const edge of parent.edges.values()) {
    const srcIn = memberSet.has(edge.src);
    const dstIn = memberSet.has(edge.dst);
    if (srcIn && dstIn) internalEdges.push(edge);
    else if (srcIn || dstIn) {
      errors.push({
        code: 'crosses-boundary',
        message: `group "${group.id}": edge "${edge.id}" crosses the group boundary — v1 has no portals (§4.3), so this grouping is not expressible`,
        group: group.id,
      });
    }
  }
  if (errors.length > 0) return { errors };

  const domain = parent.meta.domain;
  const detailGraph = deriveGraphId({ domain, source: `${group.id}\0detail`, path: [] });
  const provenance = proposalProvenance(group);

  // Reserve ids so a later group cannot collide with this one.
  claimed.add(group.id);
  claimed.add(detailGraph);
  for (const m of group.members) claimed.add(m);

  return { plan: { group, parentGraph, detailGraph, memberNodes, internalEdges, provenance }, errors: [] };
}

/**
 * Apply a whole {@link AbstractionProposal} atomically. Validates every group
 * first (returning located {@link ProposalIssue}s and writing nothing on any
 * failure), then commits one delta through `store.apply`.
 */
export function applyProposal(
  store: GraphStore,
  proposal: AbstractionProposal,
  options: ApplyProposalOptions = {},
): ApplyProposalResult {
  const space = store.snapshot();
  const nodeGraph = indexNodes(space);
  const used = usedIds(space);
  const claimed = new Set<string>();

  const plans: PlannedGroup[] = [];
  const errors: ProposalIssue[] = [];
  // Deterministic processing order (group id ascending).
  const groups = [...proposal.groups].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const group of groups) {
    const { plan, errors: e } = planGroup(space, group, nodeGraph, claimed, used);
    errors.push(...e);
    if (plan !== undefined) plans.push(plan);
  }
  if (errors.length > 0) return { ok: false, errors };
  if (plans.length === 0) return { ok: false, errors: [{ code: 'empty-group', message: 'proposal has no applicable groups' }] };

  const ops: GraphOpInput[] = [];
  for (const plan of plans) {
    const { group, parentGraph, detailGraph, memberNodes, internalEdges, provenance } = plan;
    const parent = space.graphs.get(parentGraph)!;
    const meta: GraphMeta = { label: group.label, domain: parent.meta.domain, provenance };
    ops.push({ t: 'graph:add', graph: detailGraph, meta });
    for (const edge of internalEdges) ops.push({ t: 'edge:remove', graph: parentGraph, id: edge.id, prev: edge });
    for (const node of memberNodes) ops.push({ t: 'node:remove', graph: parentGraph, id: node.id, prev: node });
    for (const node of memberNodes) ops.push({ t: 'node:add', graph: detailGraph, node });
    for (const edge of internalEdges) ops.push({ t: 'edge:add', graph: detailGraph, edge });
    const groupNode: SemanticNode = {
      id: asNodeId(group.id),
      kind: group.kind ?? 'core:cluster',
      label: group.label,
      detail: { graph: detailGraph },
      attrs: proposalAttrs(group),
      provenance,
    };
    ops.push({ t: 'node:add', graph: parentGraph, node: groupNode });
  }

  const result = store.apply({ origin: { actor: options.actor ?? 'core:abstraction' }, ops });
  if (result.ok) return { ok: true, delta: result.delta, changes: result.changes };
  return {
    ok: false,
    errors: result.errors.map((e) => ({ code: 'store-rejected' as const, message: `[${e.code}] ${e.message}` })),
  };
}
