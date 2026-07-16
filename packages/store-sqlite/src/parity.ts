/**
 * The runtime-parity scenario suite (SUBPHASES 11D: "browser and Node run
 * the same scenarios"). Scenarios are written once against the abstract
 * `ParityStack`; the Node vitest run binds it to better-sqlite3 files, the
 * browser Playwright harness binds it to the OPFS worker backend. No test
 * framework in here — results are plain data the host runner asserts on.
 */
import {
  addGraph,
  addNode,
  encodePretty,
  createGraphSpace,
  type GraphId,
  type GraphSpace,
  type NodeId,
} from '@meridian/graph-core';
import type {
  GraphManifestEntry,
  GraphStore,
  HydrationManager,
  VersionStamp,
} from '@meridian/graph-store';

export interface ParitySession {
  readonly space: GraphSpace;
  readonly version: VersionStamp;
  readonly replayedDeltas: number;
  readonly manifest?: ReadonlyMap<GraphId, GraphManifestEntry>;
  readonly store: GraphStore;
  readonly hydration?: HydrationManager;
  /** Settle post-commit notifications and checkpoint. */
  flush(): Promise<void>;
  close(): Promise<void>;
  /** End the session WITHOUT checkpointing (appends have landed; the
   * element tables lag) — the recovery scenario's crash stand-in. */
  abandon(): Promise<void>;
}

export interface ParityOpenOptions {
  readonly cold?: boolean;
  readonly checkpointEvery?: number;
  readonly initialSpace?: GraphSpace;
}

/** One durable project identity per stack; `reset` wipes it. */
export interface ParityStack {
  reset(): Promise<void>;
  open(opts?: ParityOpenOptions): Promise<ParitySession>;
}

export interface ParityOutcome {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}

const SRC = { origin: 'source' as const, uri: 'file:///parity.md' };
const DERIVED = { origin: 'derived' as const };

/** Two-level deterministic fixture: root graph with N sections, each with
 * a detail graph of M leaves. */
export function paritySpace(sections = 4, leaves = 6): GraphSpace {
  let space = createGraphSpace();
  space = addGraph(space, { id: 'g-root' as GraphId, label: 'Root', domain: 'parity', provenance: DERIVED });
  for (let s = 0; s < sections; s++) {
    const sec = `g-sec-${s}` as GraphId;
    space = addGraph(space, { id: sec, label: `Section ${s}`, domain: 'parity', provenance: DERIVED });
    for (let n = 0; n < leaves; n++) {
      space = addNode(space, sec, {
        id: `n-leaf-${s}-${n}` as NodeId,
        kind: 'parity:leaf',
        label: `Leaf ${s}.${n}`,
        attrs: { 'parity:rank': n },
        provenance: SRC,
      });
    }
    space = addNode(space, 'g-root' as GraphId, {
      id: `n-sec-${s}` as NodeId,
      kind: 'parity:section',
      label: `Section ${s}`,
      provenance: SRC,
      detail: { graph: sec },
    });
  }
  return space;
}

function addGraphDelta(i: number, volatile = false): {
  origin: { actor: string; volatile?: boolean };
  ops: [{ t: 'graph:add'; graph: GraphId; meta: { label: string; domain: string; provenance: typeof DERIVED } }];
} {
  return {
    origin: { actor: 'parity', ...(volatile ? { volatile: true } : {}) },
    ops: [
      {
        t: 'graph:add',
        graph: `g-extra-${i}` as GraphId,
        meta: { label: `Extra ${i}`, domain: 'parity', provenance: DERIVED },
      },
    ],
  };
}

function assertEqual(actual: unknown, expected: unknown, what: string): void {
  const a = typeof actual === 'string' ? actual : JSON.stringify(actual);
  const b = typeof expected === 'string' ? expected : JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${what}: expected ${b.slice(0, 120)}, got ${a.slice(0, 120)}`);
  }
}

function assertTrue(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

type Scenario = (stack: ParityStack) => Promise<void>;

const SCENARIOS: ReadonlyMap<string, Scenario> = new Map<string, Scenario>([
  [
    'roundtrip-bytes',
    async (stack) => {
      const space = paritySpace();
      const bytes = encodePretty(space);
      const created = await stack.open({ initialSpace: space });
      await created.close();
      const reopened = await stack.open();
      assertEqual(encodePretty(reopened.space), bytes, 'reopened bytes');
      assertEqual(reopened.replayedDeltas, 0, 'replayed after clean close');
      await reopened.close();
    },
  ],
  [
    'durable-version-and-mutation',
    async (stack) => {
      const created = await stack.open({ initialSpace: paritySpace() });
      for (let i = 0; i < 3; i++) {
        const applied = created.store.apply(addGraphDelta(i));
        assertTrue(applied.ok, `apply ${i} ok`);
      }
      await created.close();
      const reopened = await stack.open();
      assertEqual(reopened.version, { counter: 3, site: 'local' }, 'durable version');
      assertTrue(reopened.space.graphs.has('g-extra-2' as GraphId), 'mutation durable');
      const next = reopened.store.apply(addGraphDelta(9));
      assertTrue(next.ok && next.delta.baseVersion.counter === 3, 'version continues across sessions');
      await reopened.close();
    },
  ],
  [
    'volatile-never-durable',
    async (stack) => {
      const created = await stack.open({ initialSpace: paritySpace() });
      assertTrue(created.store.apply(addGraphDelta(1)).ok, 'semantic apply ok');
      assertTrue(created.store.apply(addGraphDelta(2, true)).ok, 'volatile apply ok');
      assertEqual(created.store.version().counter, 2, 'session version counts both');
      await created.close();
      const reopened = await stack.open();
      assertEqual(reopened.version.counter, 1, 'volatile commit is not history');
      assertTrue(!reopened.space.graphs.has('g-extra-2' as GraphId), 'volatile graph not durable');
      await reopened.close();
    },
  ],
  [
    'write-behind-abandon-recovery',
    async (stack) => {
      const created = await stack.open({ initialSpace: paritySpace(), checkpointEvery: 100 });
      for (let i = 0; i < 5; i++) assertTrue(created.store.apply(addGraphDelta(i)).ok, `apply ${i} ok`);
      await created.abandon(); // appends landed, checkpoint did not
      const recovered = await stack.open();
      assertEqual(recovered.replayedDeltas, 5, 'tail replayed at open');
      assertEqual(recovered.version.counter, 5, 'recovered version');
      assertTrue(recovered.space.graphs.has('g-extra-4' as GraphId), 'recovered content');
      await recovered.close();
    },
  ],
  [
    'cold-open-hydration-identity',
    async (stack) => {
      const space = paritySpace();
      const bytes = encodePretty(space);
      const created = await stack.open({ initialSpace: space });
      await created.close();

      const cold = await stack.open({ cold: true });
      assertTrue(cold.hydration !== undefined, 'cold open yields a hydration manager');
      assertTrue(cold.manifest !== undefined && cold.manifest.size === 5, 'manifest present');
      assertTrue(cold.space.graphs.get('g-sec-0' as GraphId)!.nodes.size === 0, 'sections are shells');
      assertEqual(cold.hydration!.state('g-sec-0' as GraphId), 'cold', 'initial state');
      for (let s = 0; s < 4; s++) await cold.hydration!.hydrate(`g-sec-${s}` as GraphId);
      assertEqual(encodePretty(cold.store.snapshot()), bytes, 'hydrated bytes equal the eager document');
      assertTrue(cold.hydration!.evict('g-sec-1' as GraphId), 'evictable after hydration');
      assertEqual(cold.hydration!.state('g-sec-1' as GraphId), 'cold', 'evicted back to cold');
      await cold.hydration!.hydrate('g-sec-1' as GraphId);
      assertEqual(encodePretty(cold.store.snapshot()), bytes, 're-hydration is byte-identical');
      await cold.close();

      const reopened = await stack.open();
      assertEqual(reopened.version.counter, 0, 'hydration churn never became history');
      assertEqual(encodePretty(reopened.space), bytes, 'durable state untouched by churn');
      await reopened.close();
    },
  ],
  [
    'edit-after-hydration-is-durable',
    async (stack) => {
      const created = await stack.open({ initialSpace: paritySpace() });
      await created.close();
      const cold = await stack.open({ cold: true });
      await cold.hydration!.hydrate('g-sec-0' as GraphId);
      const applied = cold.store.apply({
        origin: { actor: 'parity' },
        ops: [{ t: 'node:attr', graph: 'g-sec-0' as GraphId, id: 'n-leaf-0-0' as NodeId, key: 'parity:edited', next: true }],
      });
      assertTrue(applied.ok, 'edit into hydrated graph applies');
      await cold.close();
      const reopened = await stack.open();
      const node = reopened.space.graphs.get('g-sec-0' as GraphId)!.nodes.get('n-leaf-0-0' as NodeId)!;
      assertEqual(node.attrs['parity:edited'], true, 'edit survived');
      // The hydration commit burned counter 1 (volatile commits advance the
      // session counter without becoming history — ADR-0038 §3), so the one
      // semantic commit landed as counter 2. Monotonicity is the contract;
      // density is not.
      assertEqual(reopened.version.counter, 2, 'durable counter continues from the session counter');
      assertEqual(reopened.replayedDeltas, 0, 'clean close left no tail');
      await reopened.close();
    },
  ],
]);

export function parityScenarioNames(): string[] {
  return [...SCENARIOS.keys()];
}

export async function runParityScenarios(stack: ParityStack): Promise<ParityOutcome[]> {
  const outcomes: ParityOutcome[] = [];
  for (const [name, scenario] of SCENARIOS) {
    try {
      await stack.reset();
      await scenario(stack);
      outcomes.push({ name, ok: true });
    } catch (e) {
      outcomes.push({ name, ok: false, detail: e instanceof Error ? (e.stack ?? e.message) : String(e) });
    }
  }
  return outcomes;
}
