/**
 * Generators for random VALID graph spaces, built exclusively through the
 * public constructors — the property suites' model of "anything a correct
 * producer can make".
 */
import fc from 'fast-check';
import {
  addEdge,
  addGraph,
  addNode,
  asEdgeId,
  asGraphId,
  asNodeId,
  createGraphSpace,
  type GraphSpace,
  type SourceRef,
} from '../src/index.js';

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
  fc.constantFrom('図書館カタログ', '🚀 rocket ✨', 'مكتبة', 'café', 'é decomposed', ''),
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
  let space = createGraphSpace();

  for (let i = 0; i < plan.graphCount; i++) {
    space = addGraph(space, {
      id: asGraphId(`g${i}`),
      label: pick(plan.labels, i),
      domain: 'demo',
      provenance: pick(plan.provs, i),
    });
  }
  // Plain nodes.
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
  // Containment forest: graph i (i>0) becomes the detail of a fresh node in
  // an earlier graph — parent index < child index guarantees a forest.
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
  // Intra-graph edges among the plain nodes.
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
