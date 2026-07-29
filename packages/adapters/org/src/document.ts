/**
 * IR → GraphDocument: the deterministic organization skeleton (ADR-0047). The
 * containment is a four-graph chain under one corpus root graph, giving the
 * five declared zoom levels:
 *
 *   root graph                       (holds one org:organization node)
 *     └─ org  → detail graph         (holds org:team nodes)
 *          └─ team → detail graph    (holds org:role-instance / org:gate)
 *               └─ instance → detail (holds org:assignment nodes, from runs)
 *                    └─ assignment → detail (org:event / org:artifact leaves)
 *
 * Uniform depth is load-bearing: containment-depth abstraction places every
 * branch of the ladder at the same level, so instances not owned by any team
 * dock under one deterministic implicit team (`_direct`, marked
 * `org:implicit`), and run events whose role resolves to no instance dock
 * under an implicit `_system` instance inside it (ADR-0047 §3).
 *
 * Edges are same-graph only (U1). A relationship whose endpoints live in
 * different team graphs is recorded at the lowest common graph — here always
 * the org detail graph — between the two team nodes, carrying the deep
 * endpoints as `org:via-src` / `org:via-dst` attrs (the portal rule, ADR-0047
 * §5). Temporal facts live only as declared `org:*` node attrs (never on
 * edges) so the timeline projection works unchanged (ADR-0037, ADR-0047 §4).
 * Every element carries source-only provenance; IDs derive purely through
 * `ctx.ids` from stable `(domain, source, path)` coordinates.
 */
import type { GraphDocument, PluginContext, SourceDescriptor } from '@meridian/plugin-api';
import type { OrgBundleIR, OrgInstance, OrgRun, WorkflowNext } from './parse.js';

export const DOMAIN = 'org';

/** The implicit team that owns instances declared outside any team. */
export const DIRECT_TEAM = '_direct';
/** The implicit instance that owns run events naming no known instance. */
export const SYSTEM_INSTANCE = '_system';

type WireGraph = GraphDocument['graphs'][number];
type WireNode = WireGraph['nodes'][number];
type WireEdge = WireGraph['edges'][number];
type Provenance = WireNode['provenance'];
type Attrs = WireNode['attrs'];

interface MutableGraph {
  readonly id: string;
  readonly meta: WireGraph['meta'];
  readonly nodes: WireNode[];
  readonly edges: WireEdge[];
}

const PRODUCER = '@meridian/adapter-org';

/** Where an element lives for portal rebasing: its team graph plus its own
 * node id, and the org-graph team node standing for it one level up. */
interface Address {
  readonly teamSeg: string;
  readonly nodeId: string;
}

export function buildDocument(
  ctx: PluginContext,
  src: SourceDescriptor,
  ir: OrgBundleIR,
  producerVersion: string,
): GraphDocument {
  const { definition, instances, runs } = ir;
  const provenance: Provenance = { origin: 'source', uri: src.uri };
  const coords = (path: readonly string[]) => ({ domain: DOMAIN, source: src.uri, path: [...path] });

  const graphs: MutableGraph[] = [];
  const newGraph = (id: string, label: string): MutableGraph => {
    const graph: MutableGraph = {
      id,
      meta: { label, domain: DOMAIN, provenance },
      nodes: [],
      edges: [],
    };
    graphs.push(graph);
    return graph;
  };

  // --- level 1: the organization ------------------------------------------
  const rootGraphId = ctx.ids.graphId(coords([]));
  const root = newGraph(rootGraphId, `${definition.orgId}@${definition.orgVersion}`);
  const orgPath = ['org'];
  const orgNodeId = ctx.ids.nodeId(coords(orgPath));
  const orgGraphId = ctx.ids.graphId(coords(orgPath));
  root.nodes.push({
    id: orgNodeId,
    kind: 'org:organization',
    label: definition.orgId,
    detail: { graph: orgGraphId },
    attrs: {
      'org:id': definition.orgId,
      'org:version': definition.orgVersion,
      ...(definition.digest !== undefined ? { 'org:digest': definition.digest } : {}),
      'org:brain-store': definition.brainStore,
      'org:brain-root-ref': definition.brainRootRef,
    },
    provenance,
  });
  const orgGraph = newGraph(orgGraphId, definition.orgId);

  // --- level 2: teams ------------------------------------------------------
  // Deterministic team universe: declared teams in document order, then any
  // attribution value the expansion introduces, then the implicit `_direct`
  // for team-less instances (and `_system` routing, added lazily below).
  const teamSegs: string[] = [];
  const declaredPrefixes = new Set<string>();
  for (const team of definition.teams) {
    teamSegs.push(team.instancePrefix);
    declaredPrefixes.add(team.instancePrefix);
  }
  for (const instance of instances) {
    if (instance.team !== null && !declaredPrefixes.has(instance.team) && !teamSegs.includes(instance.team)) {
      teamSegs.push(instance.team);
    }
  }
  const needsDirect = instances.some((i) => i.team === null);
  if (needsDirect) teamSegs.push(DIRECT_TEAM);

  const teamNodeIds = new Map<string, string>();
  const teamGraphs = new Map<string, MutableGraph>();
  const teamGraphIds = new Map<string, string>();
  for (const teamSeg of teamSegs) {
    const teamPath = ['org', teamSeg];
    const nodeId = ctx.ids.nodeId(coords(teamPath));
    const graphId = ctx.ids.graphId(coords(teamPath));
    const declared = definition.teams.find((t) => t.instancePrefix === teamSeg);
    const label = teamSeg === DIRECT_TEAM ? 'Direct' : teamSeg;
    orgGraph.nodes.push({
      id: nodeId,
      kind: 'org:team',
      label,
      detail: { graph: graphId },
      attrs: {
        'org:index': teamSegs.indexOf(teamSeg),
        ...(teamSeg === DIRECT_TEAM ? { 'org:implicit': true } : {}),
        ...(declared !== undefined ? { 'org:template-ref': declared.templateRef } : {}),
      },
      provenance,
    });
    teamNodeIds.set(teamSeg, nodeId);
    teamGraphs.set(teamSeg, newGraph(graphId, label));
    teamGraphIds.set(teamSeg, graphId);
  }

  // --- level 3: role instances and gates -----------------------------------
  const instanceAddress = new Map<string, Address>();
  const instanceDetail = new Map<string, { graph: MutableGraph; path: readonly string[] }>();
  const instanceSegOf = (instance: OrgInstance): string => instance.team ?? DIRECT_TEAM;

  const pushInstance = (
    teamSeg: string,
    instanceId: string,
    roleType: string,
    engine: string | null,
    index: number,
    implicit: boolean,
  ): void => {
    const teamGraph = teamGraphs.get(teamSeg);
    if (teamGraph === undefined) return; // teams are pre-materialized above
    const path = ['org', teamSeg, instanceId];
    const nodeId = ctx.ids.nodeId(coords(path));
    // Detail graphs are only referenced when a run event lands here; the node
    // is patched with `detail` lazily so an empty instance stays a leaf.
    teamGraph.nodes.push({
      id: nodeId,
      kind: 'org:role-instance',
      label: instanceId,
      attrs: {
        'org:index': index,
        'org:role-type': roleType,
        ...(engine !== null ? { 'org:engine': engine } : {}),
        ...(implicit ? { 'org:implicit': true } : {}),
      },
      provenance,
    });
    instanceAddress.set(instanceId, { teamSeg, nodeId });
  };

  instances.forEach((instance, index) => {
    pushInstance(instanceSegOf(instance), instance.instanceId, instance.roleType, instance.engine, index, false);
  });

  // --- workflow topology → edges -------------------------------------------
  // A workflow kind's owner: the assignee of the row that carries it, or —
  // when a declared workflow hands off into a team boundary (kinds stamped
  // `<prefix>.<kind>` whose rows only exist after expansion) — the team node
  // itself. Anything else is honestly unresolvable and emits no edge.
  const rowByKind = new Map(definition.workflow.map((row) => [row.kind, row]));
  const producerByKind = new Map(definition.workflow.map((row) => [row.produces, row]));

  type Owner = { readonly kind: 'instance'; readonly id: string } | { readonly kind: 'team'; readonly seg: string };
  const ownerOfInstanceId = (id: string): Owner | undefined => {
    if (instanceAddress.has(id)) return { kind: 'instance', id };
    for (const seg of declaredPrefixes) {
      if (id.startsWith(`${seg}.`)) return { kind: 'team', seg };
    }
    return undefined;
  };
  const ownerOfKind = (kind: string): Owner | undefined => {
    const row = rowByKind.get(kind);
    if (row !== undefined) return ownerOfInstanceId(row.assignee);
    for (const seg of declaredPrefixes) {
      if (kind.startsWith(`${seg}.`)) return { kind: 'team', seg };
    }
    return undefined;
  };

  // U1: an edge must stay inside one graph. Two instances in the same team
  // link directly; anything else rebases to the org graph between the two
  // team nodes with the deep endpoints preserved as via-attrs (portal rule).
  const occurrence = new Map<string, number>();
  const emitEdge = (from: Owner, to: Owner, kind: string, attrs: Attrs): void => {
    let graph: MutableGraph | undefined;
    let srcId: string | undefined;
    let dstId: string | undefined;
    const via: Record<string, string> = {};

    if (from.kind === 'instance' && to.kind === 'instance') {
      const a = instanceAddress.get(from.id);
      const b = instanceAddress.get(to.id);
      if (a === undefined || b === undefined) return;
      if (a.teamSeg === b.teamSeg) {
        graph = teamGraphs.get(a.teamSeg);
        srcId = a.nodeId;
        dstId = b.nodeId;
      } else {
        graph = orgGraph;
        srcId = teamNodeIds.get(a.teamSeg);
        dstId = teamNodeIds.get(b.teamSeg);
        via['org:via-src'] = a.nodeId;
        via['org:via-dst'] = b.nodeId;
      }
    } else {
      const teamSegFor = (owner: Owner): string | undefined =>
        owner.kind === 'team' ? owner.seg : instanceAddress.get(owner.id)?.teamSeg;
      const a = teamSegFor(from);
      const b = teamSegFor(to);
      if (a === undefined || b === undefined) return;
      graph = orgGraph;
      srcId = teamNodeIds.get(a);
      dstId = teamNodeIds.get(b);
      if (from.kind === 'instance') {
        const addr = instanceAddress.get(from.id);
        if (addr !== undefined) via['org:via-src'] = addr.nodeId;
      }
      if (to.kind === 'instance') {
        const addr = instanceAddress.get(to.id);
        if (addr !== undefined) via['org:via-dst'] = addr.nodeId;
      }
    }
    if (graph === undefined || srcId === undefined || dstId === undefined) return;
    if (srcId === dstId) return; // a self-link induces nothing at this level

    const occKey = `${graph.id} ${kind} ${srcId} ${dstId}`;
    const occ = occurrence.get(occKey) ?? 0;
    occurrence.set(occKey, occ + 1);
    graph.edges.push({
      id: ctx.ids.edgeId({
        graph: graph.id,
        kind,
        src: srcId,
        dst: dstId,
        ...(occ > 0 ? { occurrence: String(occ) } : {}),
      }),
      src: srcId,
      dst: dstId,
      kind,
      attrs: { ...attrs, ...via },
      provenance,
    });
  };

  const isConditional = (next: WorkflowNext): next is { readonly onVerdict: ReadonlyMap<string, string> } =>
    !Array.isArray(next);
  const nextTargets = (next: WorkflowNext): readonly { kind: string; verdict?: string }[] =>
    isConditional(next)
      ? [...next.onVerdict.entries()].map(([verdict, kind]) => ({ kind, verdict }))
      : next.map((kind) => ({ kind }));

  for (const row of definition.workflow) {
    const owner = ownerOfInstanceId(row.assignee);
    if (owner === undefined) continue;
    for (const target of nextTargets(row.next)) {
      const to = ownerOfKind(target.kind);
      if (to === undefined) continue;
      emitEdge(owner, to, 'org:then', {
        'org:row-kind': row.kind,
        ...(target.verdict !== undefined ? { 'org:verdict': target.verdict } : {}),
      });
    }
    for (const input of row.requiredInputs) {
      const producerRow = producerByKind.get(input);
      if (producerRow === undefined) continue; // user-supplied inputs have no producer
      const from = ownerOfInstanceId(producerRow.assignee);
      if (from === undefined) continue;
      emitEdge(from, owner, 'org:feeds', { 'org:row-kind': row.kind, 'org:input': input });
    }
    const reviewer = ownerOfInstanceId(row.reviewer);
    if (reviewer !== undefined) emitEdge(owner, reviewer, 'org:reviewed-by', { 'org:row-kind': row.kind });
    const escalation = ownerOfInstanceId(row.escalationRoute);
    if (escalation !== undefined) emitEdge(owner, escalation, 'org:escalates-to', { 'org:row-kind': row.kind });
  }

  // Gates: a gate node sits beside the instances it governs — in the team
  // graph of the first `over` kind's instance owner; a gate whose first owner
  // is a team boundary sits in the org graph beside that team.
  definition.gates.forEach((gate, gi) => {
    const firstOwner = gate.over.map(ownerOfKind).find((o) => o !== undefined);
    const gatePath = ['org', 'gate', gate.gateId];
    const gateNodeId = ctx.ids.nodeId(coords(gatePath));
    const host =
      firstOwner === undefined || firstOwner.kind === 'team'
        ? orgGraph
        : (teamGraphs.get(instanceAddress.get(firstOwner.id)?.teamSeg ?? '') ?? orgGraph);
    host.nodes.push({
      id: gateNodeId,
      kind: 'org:gate',
      label: gate.gateId,
      attrs: { 'org:index': gi },
      provenance,
    });
    const gateOwner: { kind: 'gate'; nodeId: string; graph: MutableGraph } = {
      kind: 'gate',
      nodeId: gateNodeId,
      graph: host,
    };
    for (const kind of gate.over) {
      const to = ownerOfKind(kind);
      if (to === undefined) continue;
      // A gate edge stays in the gate's own graph: to a same-graph instance
      // directly, else to the target's team node when hosted in the org graph.
      let dstId: string | undefined;
      if (to.kind === 'instance') {
        const addr = instanceAddress.get(to.id);
        if (addr === undefined) continue;
        dstId = gateOwner.graph === teamGraphs.get(addr.teamSeg) ? addr.nodeId : teamNodeIds.get(addr.teamSeg);
      } else {
        dstId = gateOwner.graph === orgGraph ? teamNodeIds.get(to.seg) : undefined;
      }
      if (dstId === undefined || gateOwner.graph === undefined) continue;
      if (gateOwner.graph !== orgGraph && dstId !== undefined) {
        const inHost = gateOwner.graph.nodes.some((n) => n.id === dstId);
        if (!inHost) continue; // honestly omit rather than cross graphs
      }
      const occKey = `${gateOwner.graph.id} org:gates ${gateNodeId} ${dstId}`;
      const occ = occurrence.get(occKey) ?? 0;
      occurrence.set(occKey, occ + 1);
      gateOwner.graph.edges.push({
        id: ctx.ids.edgeId({
          graph: gateOwner.graph.id,
          kind: 'org:gates',
          src: gateNodeId,
          dst: dstId,
          ...(occ > 0 ? { occurrence: String(occ) } : {}),
        }),
        src: gateNodeId,
        dst: dstId,
        kind: 'org:gates',
        attrs: { 'org:input': kind },
        provenance,
      });
    }
  });

  // --- levels 4-5: assignments, events, artifacts (runs) --------------------
  const ensureSystemInstance = (): void => {
    if (instanceAddress.has(SYSTEM_INSTANCE)) return;
    if (!teamGraphs.has(DIRECT_TEAM)) {
      // materialize the implicit team late (bundle of a fully-teamed org)
      const teamPath = ['org', DIRECT_TEAM];
      const nodeId = ctx.ids.nodeId(coords(teamPath));
      const graphId = ctx.ids.graphId(coords(teamPath));
      orgGraph.nodes.push({
        id: nodeId,
        kind: 'org:team',
        label: 'Direct',
        detail: { graph: graphId },
        attrs: { 'org:index': teamSegs.length, 'org:implicit': true },
        provenance,
      });
      teamNodeIds.set(DIRECT_TEAM, nodeId);
      teamGraphs.set(DIRECT_TEAM, newGraph(graphId, 'Direct'));
      teamGraphIds.set(DIRECT_TEAM, graphId);
      teamSegs.push(DIRECT_TEAM);
    }
    pushInstance(DIRECT_TEAM, SYSTEM_INSTANCE, 'system', null, instances.length, true);
  };

  const roleTypeIndex = new Map<string, string>();
  for (const instance of instances) {
    if (!roleTypeIndex.has(instance.roleType)) roleTypeIndex.set(instance.roleType, instance.instanceId);
  }
  const resolveEventInstance = (role: string): string => {
    if (instanceAddress.has(role)) return role;
    const byType = roleTypeIndex.get(role);
    if (byType !== undefined) return byType;
    ensureSystemInstance();
    return SYSTEM_INSTANCE;
  };

  const ensureInstanceDetail = (instanceId: string): { graph: MutableGraph; path: readonly string[] } => {
    const existing = instanceDetail.get(instanceId);
    if (existing !== undefined) return existing;
    const address = instanceAddress.get(instanceId);
    if (address === undefined) throw new Error(`unresolved instance ${instanceId}`); // unreachable
    const path = ['org', address.teamSeg, instanceId];
    const graphId = ctx.ids.graphId(coords(path));
    const graph = newGraph(graphId, instanceId);
    const teamGraph = teamGraphs.get(address.teamSeg);
    const node = teamGraph?.nodes.find((n) => n.id === address.nodeId);
    if (node !== undefined) (node as { detail?: { graph: string } }).detail = { graph: graphId };
    const made = { graph, path };
    instanceDetail.set(instanceId, made);
    return made;
  };

  // Assignment state: a conservative, deterministic reading of the event
  // kinds present (ADR-0047 §3): escalation ⊃ promotion ⊃ deliverable ⊃
  // pending question ⊃ in progress. The adapter never invents verdicts.
  const stateOf = (events: readonly OrgRun['events'][number][]): string => {
    const kinds = new Set(events.map((e) => e.kind));
    if (kinds.has('escalation')) return 'escalated';
    if (kinds.has('promotion')) return 'accepted';
    if (kinds.has('deliverable')) return 'delivered';
    if (kinds.has('question')) return 'awaiting_answer';
    return 'in_progress';
  };

  for (const run of runs) {
    const byInstance = new Map<string, typeof run.events[number][]>();
    for (const event of run.events) {
      const instanceId = resolveEventInstance(event.role);
      const bucket = byInstance.get(instanceId);
      if (bucket === undefined) byInstance.set(instanceId, [event]);
      else bucket.push(event);
    }
    for (const [instanceId, events] of byInstance) {
      const detail = ensureInstanceDetail(instanceId);
      const assignmentPath = [...detail.path, run.jobId];
      const assignmentNodeId = ctx.ids.nodeId(coords(assignmentPath));
      const assignmentGraphId = ctx.ids.graphId(coords(assignmentPath));
      const first = events[0]!;
      const last = events[events.length - 1]!;
      detail.graph.nodes.push({
        id: assignmentNodeId,
        kind: 'org:assignment',
        label: `${run.jobId.slice(0, 8)} · ${instanceId}`,
        detail: { graph: assignmentGraphId },
        attrs: {
          'org:job-id': run.jobId,
          ...(run.orgDigest !== null ? { 'org:org-digest': run.orgDigest } : {}),
          'org:lane': instanceId,
          'org:state': stateOf(events),
          'org:started-at': first.timestamp,
          'org:ended-at': last.timestamp,
        },
        provenance,
      });
      const assignmentGraph = newGraph(assignmentGraphId, `${run.jobId.slice(0, 8)} · ${instanceId}`);
      for (const event of events) {
        const eventNodeId = ctx.ids.nodeId(coords([...assignmentPath, `e-${event.seq}`]));
        assignmentGraph.nodes.push({
          id: eventNodeId,
          kind: 'org:event',
          label: event.rawEvent,
          attrs: {
            'org:seq': event.seq,
            'org:kind': event.kind,
            'org:raw': event.rawEvent,
            'org:lane': instanceId,
            'org:started-at': event.timestamp,
            ...(event.detail.length > 0 ? { 'org:detail': event.detail } : {}),
          },
          provenance,
        });
        if (event.kind === 'deliverable') {
          const artifactNodeId = ctx.ids.nodeId(coords([...assignmentPath, `a-${event.seq}`]));
          assignmentGraph.nodes.push({
            id: artifactNodeId,
            kind: 'org:artifact',
            label: event.detail.length > 0 ? event.detail : event.rawEvent,
            attrs: {
              'org:seq': event.seq,
              'org:lane': instanceId,
              'org:started-at': event.timestamp,
            },
            provenance,
          });
          assignmentGraph.edges.push({
            id: ctx.ids.edgeId({
              graph: assignmentGraphId,
              kind: 'org:produced',
              src: eventNodeId,
              dst: artifactNodeId,
            }),
            src: eventNodeId,
            dst: artifactNodeId,
            kind: 'org:produced',
            provenance,
          });
        }
      }
    }
  }

  return {
    formatVersion: 1,
    producer: { name: PRODUCER, version: producerVersion },
    roots: [rootGraphId],
    graphs,
  };
}
