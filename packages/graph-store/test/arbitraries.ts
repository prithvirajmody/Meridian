/**
 * Generators. `spaceArb` mirrors graph-core's (built exclusively through
 * public constructors). `mutationPlanArb` generates op sequences that are
 * valid by construction: abstract intents interpreted against a scratch
 * store, so each op targets real, current state.
 */
import fc from 'fast-check';
import {
  addEdge,
  addGraph,
  addNode,
  asEdgeId,
  asGraphId,
  asNodeId,
  buildContainmentIndex,
  containmentPathOf,
  type GraphId,
  type GraphSpace,
  type SourceRef,
} from '@meridian/graph-core';
import { createStore, type GraphOpInput } from '../src/index.js';

export const provenanceArb: fc.Arbitrary<SourceRef> = fc
  .record(
    {
      origin: fc.constantFrom<'source' | 'derived' | 'ai'>('source', 'derived', 'ai'),
      uri: fc.constantFrom('test://a', 'file:///tmp/x.md', 'https://example.com/p'),
      confidence: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
      span: fc
        .tuple(fc.nat(1000), fc.nat(1000))
        .map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as [number, number]),
    },
    { requiredKeys: ['origin'] },
  )
  .map((p) => p as SourceRef);

export const labelArb: fc.Arbitrary<string> = fc.oneof(
  fc.string({ maxLength: 12 }),
  fc.constantFrom('図書館カタログ', '🚀 rocket ✨', 'مكتبة', 'café', 'é decomposed', ''),
);

export const kindArb: fc.Arbitrary<string> = fc.constantFrom(
  'demo:step',
  'demo:module',
  'doc:section',
  'core:cluster',
  'x:y-2',
);

const attrValueArb = fc.oneof(
  fc.string({ maxLength: 8 }),
  fc.integer({ min: -1000, max: 1000 }),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.string({ maxLength: 4 }), { maxLength: 3 }),
);

export const attrsArb = fc.dictionary(
  fc.constantFrom('demo:count', 'demo:note', 'doc:words', 'x:flag'),
  attrValueArb,
  { maxKeys: 2 },
);

interface SpacePlan {
  readonly graphCount: number;
  readonly nodeCounts: readonly number[];
  readonly parentSeeds: readonly number[];
  readonly labels: readonly string[];
  readonly kinds: readonly string[];
  readonly provs: readonly SourceRef[];
  readonly attrs: readonly Record<string, unknown>[];
  readonly edgeSpecs: readonly {
    g: number;
    s: number;
    d: number;
    kind: string;
    weight: number | undefined;
  }[];
}

const MAX_GRAPHS = 5;

const planArb: fc.Arbitrary<SpacePlan> = fc.record({
  graphCount: fc.integer({ min: 1, max: MAX_GRAPHS }),
  nodeCounts: fc.array(fc.integer({ min: 1, max: 5 }), {
    minLength: MAX_GRAPHS,
    maxLength: MAX_GRAPHS,
  }),
  parentSeeds: fc.array(fc.nat(1000), { minLength: MAX_GRAPHS, maxLength: MAX_GRAPHS }),
  labels: fc.array(labelArb, { minLength: 40, maxLength: 40 }),
  kinds: fc.array(kindArb, { minLength: 40, maxLength: 40 }),
  provs: fc.array(provenanceArb, { minLength: 40, maxLength: 40 }),
  attrs: fc.array(attrsArb, { minLength: 40, maxLength: 40 }),
  edgeSpecs: fc.array(
    fc.record({
      g: fc.nat(1000),
      s: fc.nat(1000),
      d: fc.nat(1000),
      kind: kindArb,
      weight: fc.option(fc.integer({ min: -5, max: 5 }), { nil: undefined }),
    }),
    { maxLength: 12 },
  ),
});

function buildSpace(plan: SpacePlan): GraphSpace {
  const pick = <T>(arr: readonly T[], i: number): T => arr[i % arr.length]!;
  let space: GraphSpace = { graphs: new Map(), roots: [] };

  for (let i = 0; i < plan.graphCount; i++) {
    space = addGraph(space, {
      id: asGraphId(`g${i}`),
      label: pick(plan.labels, i),
      domain: 'demo',
      provenance: pick(plan.provs, i),
    });
  }
  for (let i = 0; i < plan.graphCount; i++) {
    const count = plan.nodeCounts[i]!;
    for (let j = 0; j < count; j++) {
      space = addNode(space, asGraphId(`g${i}`), {
        id: asNodeId(`n${i}-${j}`),
        kind: pick(plan.kinds, i * 7 + j),
        label: pick(plan.labels, i * 5 + j),
        attrs: pick(plan.attrs, i * 3 + j) as never,
        provenance: pick(plan.provs, i * 11 + j),
      });
    }
  }
  for (let i = 1; i < plan.graphCount; i++) {
    const parent = plan.parentSeeds[i]! % i;
    space = addNode(space, asGraphId(`g${parent}`), {
      id: asNodeId(`n${parent}-container-${i}`),
      kind: 'demo:module',
      label: pick(plan.labels, 20 + i),
      detail: { graph: asGraphId(`g${i}`) },
      provenance: pick(plan.provs, 20 + i),
    });
  }
  plan.edgeSpecs.forEach((spec, k) => {
    const g = spec.g % plan.graphCount;
    const count = plan.nodeCounts[g]!;
    space = addEdge(space, asGraphId(`g${g}`), {
      id: asEdgeId(`e${g}-${k}`),
      src: asNodeId(`n${g}-${spec.s % count}`),
      dst: asNodeId(`n${g}-${spec.d % count}`),
      kind: spec.kind,
      ...(spec.weight !== undefined ? { weight: spec.weight } : {}),
      provenance: pick(plan.provs, k),
    });
  });
  return space;
}

/** Random valid GraphSpace: 1–5 graphs, forest containment, unicode labels. */
export const spaceArb: fc.Arbitrary<GraphSpace> = planArb.map(buildSpace);

// ------------------------------------------------------- mutation sequences

export interface MutationCase {
  readonly space: GraphSpace;
  readonly ops: readonly GraphOpInput[];
}

interface Intent {
  readonly action: number;
  readonly seeds: readonly number[];
  readonly label: string;
  readonly attrs: Record<string, unknown>;
  readonly prov: SourceRef;
}

const intentArb: fc.Arbitrary<Intent> = fc.record({
  action: fc.nat(8),
  seeds: fc.array(fc.nat(10_000), { minLength: 4, maxLength: 4 }),
  label: labelArb,
  attrs: attrsArb,
  prov: provenanceArb,
});

const sortById = <T extends { id: string }>(items: T[]): T[] =>
  items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/**
 * Interpret one intent against the current space; returns a valid op or
 * undefined when no target exists (intent skipped).
 */
function realizeIntent(space: GraphSpace, intent: Intent, n: number): GraphOpInput | undefined {
  const pick = <T>(arr: readonly T[], seed: number): T | undefined =>
    arr.length === 0 ? undefined : arr[seed % arr.length];
  const graphs = sortById([...space.graphs.values()]);
  const [s0, s1, s2, s3] = intent.seeds as [number, number, number, number];
  const allNodes = graphs.flatMap((g) =>
    [...g.nodes.values()].map((node) => ({ id: node.id, graph: g.id, node })),
  );
  const allEdges = graphs.flatMap((g) =>
    [...g.edges.values()].map((edge) => ({ id: edge.id, graph: g.id, edge })),
  );
  const degree = new Map<string, number>();
  for (const { edge } of allEdges) {
    degree.set(edge.src, (degree.get(edge.src) ?? 0) + 1);
    degree.set(edge.dst, (degree.get(edge.dst) ?? 0) + 1);
  }
  const index = buildContainmentIndex(space);
  const kinds = ['demo:step', 'demo:module', 'doc:section'];
  const keys = ['demo:count', 'demo:note', 'x:flag'];

  /** Roots claimable as the detail of a node hosted in `host` (U2-safe). */
  const claimableRoots = (host: GraphId): GraphId[] => {
    const ancestors = new Set(containmentPathOf(space, host, index));
    return graphs.map((g) => g.id).filter((id) => !index.has(id) && !ancestors.has(id));
  };

  switch (intent.action) {
    case 0:
      return {
        t: 'graph:add',
        graph: asGraphId(`gx-${n}`),
        meta: { label: intent.label, domain: 'demo', provenance: intent.prov },
      };
    case 1: {
      const target = pick(
        graphs.filter((g) => g.nodes.size === 0 && g.edges.size === 0 && !index.has(g.id)),
        s0,
      );
      return target ? { t: 'graph:remove', graph: target.id } : undefined;
    }
    case 2: {
      const target = pick(graphs, s0);
      return target
        ? {
            t: 'graph:meta',
            graph: target.id,
            next: { label: intent.label, domain: 'demo', provenance: intent.prov },
          }
        : undefined;
    }
    case 3: {
      const host = pick(graphs, s0);
      if (!host) return undefined;
      const withDetail = s1 % 3 === 0 ? pick(claimableRoots(host.id), s2) : undefined;
      return {
        t: 'node:add',
        graph: host.id,
        node: {
          id: asNodeId(`nx-${n}`),
          kind: pick(kinds, s3)!,
          label: intent.label,
          ...(withDetail !== undefined ? { detail: { graph: withDetail } } : {}),
          attrs: intent.attrs as never,
          provenance: intent.prov,
        },
      };
    }
    case 4: {
      const target = pick(allNodes.filter(({ id }) => (degree.get(id) ?? 0) === 0), s0);
      return target ? { t: 'node:remove', graph: target.graph, id: target.node.id } : undefined;
    }
    case 5: {
      const target = pick(allNodes, s0);
      if (!target) return undefined;
      const key = pick(keys, s1)!;
      const remove = s2 % 4 === 0;
      return {
        t: 'node:attr',
        graph: target.graph,
        id: target.node.id,
        key,
        ...(remove ? {} : { next: s3 % 2 === 0 ? s3 : intent.label }),
      };
    }
    case 6: {
      const target = pick(allNodes, s0);
      if (!target) return undefined;
      if (target.node.detail && s1 % 2 === 0) {
        return { t: 'node:detail', graph: target.graph, id: target.node.id };
      }
      if (target.node.detail) return undefined; // re-claiming while claimed: covered by clear+set pairs
      const claim = pick(claimableRoots(target.graph), s2);
      return claim !== undefined
        ? { t: 'node:detail', graph: target.graph, id: target.node.id, next: { graph: claim } }
        : undefined;
    }
    case 7: {
      const host = pick(graphs.filter((g) => g.nodes.size > 0), s0);
      if (!host) return undefined;
      const nodes = sortById([...host.nodes.values()]);
      return {
        t: 'edge:add',
        graph: host.id,
        edge: {
          id: asEdgeId(`ex-${n}`),
          src: pick(nodes, s1)!.id,
          dst: pick(nodes, s2)!.id,
          kind: pick(kinds, s3)!,
          attrs: {},
          provenance: intent.prov,
        },
      };
    }
    case 8: {
      const target = pick(allEdges, s0);
      return target ? { t: 'edge:remove', graph: target.graph, id: target.edge.id } : undefined;
    }
    default:
      return undefined;
  }
}

/** A space plus a sequence of ops valid against its successive states. */
export const mutationCaseArb: fc.Arbitrary<MutationCase> = fc
  .tuple(spaceArb, fc.array(intentArb, { minLength: 1, maxLength: 15 }))
  .map(([space, intents]) => {
    const scratch = createStore(space);
    const ops: GraphOpInput[] = [];
    intents.forEach((intent, n) => {
      const op = realizeIntent(scratch.snapshot(), intent, n);
      if (!op) return;
      const result = scratch.apply({ origin: { actor: 'gen' }, ops: [op] });
      if (!result.ok) {
        throw new Error(
          `generator bug: intent produced a rejected op: ${JSON.stringify(op)} → ${JSON.stringify(result.errors)}`,
        );
      }
      ops.push(op);
    });
    return { space, ops };
  })
  .filter((c) => c.ops.length > 0);
