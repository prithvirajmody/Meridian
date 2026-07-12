/**
 * The incremental adapter (7G): `CodeIncrementalSession.update` turns one file
 * change into a **minimal**, store-valid `GraphDelta`. Every delta this suite
 * produces is applied to a **real** `graph-store` and re-gated, so "minimal"
 * never means "invalid": the flagship whitespace→empty invariant (ADR-0028), an
 * asserted-op-count single-function edit, rename = remove+add, the <100ms p95
 * budget, hot-body composition (ADR-0027), and file add/delete/syntax-error are
 * all checked against the engine, for both TypeScript and Python.
 */
import {
  decode,
  deriveGraphId,
  encode,
  type GraphSpace,
  type VocabularyRegistry,
} from '@meridian/graph-core';
import { createStore, decodeDeltaInput, type GraphStore } from '@meridian/graph-store';
import type { DeltaWire, IdFacade, IngestSink } from '@meridian/plugin-api';
import { afterAll, describe, expect, it } from 'vitest';
import {
  codeManifest,
  createCodeIncrementalSession,
  type CodeIncrementalSession,
} from '../src/index.js';
import { inProcessMapper, testContext } from './support.js';

const mapper = inProcessMapper();
afterAll(() => mapper.dispose());
const ids: IdFacade = testContext().ids;

const vocabulary: VocabularyRegistry = {
  kinds: new Set(codeManifest.kinds ?? []),
  attrs: new Map(Object.entries(codeManifest.attrSchemas ?? {}).map(([k, v]) => [k, v.type])),
};

type File = { path: string; text: string };

async function session(files: File[], root = 'proj'): Promise<CodeIncrementalSession> {
  return createCodeIncrementalSession({ mapper, ids }, { root, files });
}

/** A store seeded from a session's eager document, gate-decoded. */
function storeOf(s: CodeIncrementalSession): GraphStore {
  const decoded = decode(s.document(), { vocabulary });
  if (!decoded.ok) throw new Error(`eager doc did not gate-decode: ${JSON.stringify(decoded.errors)}`);
  return createStore(decoded.space);
}

/** Collect the delta(s) one `update`/`resolveBody` call emits. */
function collector(): { sink: IngestSink; deltas: DeltaWire[] } {
  const deltas: DeltaWire[] = [];
  return {
    deltas,
    sink: { emitDocument: () => undefined, emitDelta: (d) => deltas.push(d), progress: () => undefined },
  };
}

/** Apply every non-empty delta to the store; throws if any is rejected. (An
 * empty delta is a valid no-op the store declines to commit — nothing to apply.) */
function applyAll(store: GraphStore, deltas: readonly DeltaWire[]): void {
  for (const d of deltas) {
    if (d.ops.length === 0) continue;
    const decoded = decodeDeltaInput(d);
    if (!decoded.ok) throw new Error(`delta did not decode: ${JSON.stringify(decoded.errors)}`);
    const applied = store.apply(decoded.delta);
    if (!applied.ok) throw new Error(`delta rejected by store: ${JSON.stringify(applied.errors)}`);
  }
}

function allNodes(space: GraphSpace): { id: string; kind: string; label: string; detail?: { graph: string } }[] {
  const out: { id: string; kind: string; label: string; detail?: { graph: string } }[] = [];
  for (const g of space.graphs.values()) for (const n of g.nodes.values()) out.push(n);
  return out;
}

function nodeByLabel(space: GraphSpace, kind: string, label: string): { id: string; detail?: { graph: string } } {
  const n = allNodes(space).find((x) => x.kind === kind && x.label === label);
  if (n === undefined) throw new Error(`no ${kind} labelled "${label}"`);
  return n;
}

// ---- fixtures kept tiny and self-contained so op counts are exact ----------

const TS_ADD = `export function add(a: number, b: number): number {
  return a + b;
}

export function mul(a: number, b: number): number {
  return a * b;
}
`;

const PY_ADD = `def add(a: int, b: int) -> int:
    return a + b


def mul(a: int, b: int) -> int:
    return a * b
`;

// ------------------------------------------------------------- flagship: empty

describe('7G incremental — whitespace-only edit ⇒ EMPTY delta (ADR-0028, flagship)', () => {
  for (const [lang, path, text] of [
    ['TypeScript', 'add.ts', TS_ADD],
    ['Python', 'add.py', PY_ADD],
  ] as const) {
    it(`${lang}: reformatting a file emits a delta with zero ops`, async () => {
      const s = await session([{ path, text }]);
      const store = storeOf(s);
      const before = encode(store.snapshot());

      // Pure whitespace: a leading blank line + a doubled internal blank line.
      const reformatted = '\n' + text.replace('\n\n', '\n\n\n');
      const v0 = store.version();
      const { sink, deltas } = collector();
      await s.update({ path, oldText: text, newText: reformatted }, sink);

      expect(deltas).toHaveLength(1);
      expect(deltas[0]!.ops).toHaveLength(0); // EMPTY — the flagship invariant
      applyAll(store, deltas); // an empty delta is a no-op: nothing committed
      // The store never advanced; stored spans lag until a substantive touch (ADR-0028).
      expect(store.version()).toEqual(v0);
      expect(encode(store.snapshot())).toStrictEqual(before);
    });
  }
});

// ------------------------------------------- single-function edit, op-count asserted

describe('7G incremental — single-function edit ⇒ delta over only that subtree', () => {
  it('TypeScript: changing one return type is exactly one node:attr op', async () => {
    const s = await session([{ path: 'add.ts', text: TS_ADD }]);
    const store = storeOf(s);
    const add = nodeByLabel(store.snapshot(), 'code:function', 'add');

    // Only `add`'s return annotation changes; `mul` and everything else is byte-identical.
    const edited = TS_ADD.replace('function add(a: number, b: number): number', 'function add(a: number, b: number): Big');
    const { sink, deltas } = collector();
    await s.update({ path: 'add.ts', newText: edited }, sink);

    const ops = deltas[0]!.ops as { t: string; id?: string; key?: string; next?: unknown }[];
    expect(ops).toHaveLength(1);
    expect(ops[0]!.t).toBe('node:attr');
    expect(ops[0]!.id).toBe(add.id); // touches only `add`
    expect(ops[0]!.key).toBe('code:returns');
    expect(ops[0]!.next).toBe('Big');
    applyAll(store, deltas);
    expect(nodeByLabel(store.snapshot(), 'code:function', 'add').id).toBe(add.id); // id stable
  });

  it('Python: changing one return type is exactly one node:attr op', async () => {
    const s = await session([{ path: 'add.py', text: PY_ADD }]);
    const store = storeOf(s);
    const add = nodeByLabel(store.snapshot(), 'code:function', 'add');
    const edited = PY_ADD.replace('def add(a: int, b: int) -> int:', 'def add(a: int, b: int) -> Big:');
    const { sink, deltas } = collector();
    await s.update({ path: 'add.py', newText: edited }, sink);
    const ops = deltas[0]!.ops as { t: string; id?: string; key?: string }[];
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ t: 'node:attr', id: add.id, key: 'code:returns' });
    applyAll(store, deltas);
  });
});

// ---------------------------------------------------- rename = remove + add (ADR-0028)

describe('7G incremental — rename is remove + add, never a rename op (ADR-0028)', () => {
  it('TypeScript: renaming a function removes the old id and adds a new one', async () => {
    const s = await session([{ path: 'add.ts', text: TS_ADD }]);
    const store = storeOf(s);
    const oldId = nodeByLabel(store.snapshot(), 'code:function', 'add').id;

    const edited = TS_ADD.replace(/add/g, 'sum');
    const { sink, deltas } = collector();
    await s.update({ path: 'add.ts', newText: edited }, sink);

    const ops = deltas[0]!.ops as { t: string; id?: string; node?: { id: string; label: string } }[];
    expect(ops.some((o) => o.t === 'node:remove' && o.id === oldId)).toBe(true);
    const addOp = ops.find((o) => o.t === 'node:add' && o.node?.label === 'sum');
    expect(addOp).toBeDefined();
    expect(addOp!.node!.id).not.toBe(oldId); // a genuinely new identity
    // No op type names a "rename"/"move" — v1 has no rename detection.
    expect(ops.every((o) => o.t !== 'node:move' && o.t !== 'node:rename')).toBe(true);

    applyAll(store, deltas);
    const after = store.snapshot();
    expect(allNodes(after).some((n) => n.label === 'add')).toBe(false);
    expect(nodeByLabel(after, 'code:function', 'sum').id).toBe(addOp!.node!.id);
  });
});

// ------------------------------------------------------------- latency: <100ms p95

describe('7G incremental — edit ⇒ applied delta < 100ms p95', () => {
  it('measures update()+apply over a burst of edits and reports p95', async () => {
    const s = await session([{ path: 'add.ts', text: TS_ADD }]);
    const store = storeOf(s);
    // Warm the grammar runtime so the measured edits exclude one-time init.
    await s.update({ path: 'add.ts', newText: TS_ADD + '\n' }, (() => collector().sink)());

    const timings: number[] = [];
    for (let i = 0; i < 40; i++) {
      // A signature edit each iteration ⇒ a real (non-empty) node:attr delta.
      const text = TS_ADD.replace('function mul(a: number, b: number): number', `function mul(a: number, b: number): R${i}`);
      const { sink, deltas } = collector();
      const t0 = performance.now();
      await s.update({ path: 'add.ts', newText: text }, sink);
      applyAll(store, deltas);
      timings.push(performance.now() - t0);
    }
    timings.sort((a, b) => a - b);
    const p95 = timings[Math.min(timings.length - 1, Math.floor(timings.length * 0.95))]!;
    const mean = timings.reduce((a, b) => a + b, 0) / timings.length;
    console.log(`[7G] edit→applied delta over ${timings.length} edits: mean ${mean.toFixed(2)}ms · p95 ${p95.toFixed(2)}ms`);
    expect(p95).toBeLessThan(100);
  });
});

// -------------------------------------------------- hot-body composition (ADR-0027)

describe('7G incremental — hot-body composition (ADR-0027)', () => {
  it('re-materializes only hot bodies; cold stay cold; unchanged hot ⇒ empty', async () => {
    const s = await session([{ path: 'add.ts', text: TS_ADD }]);
    const store = storeOf(s);
    const add = nodeByLabel(store.snapshot(), 'code:function', 'add');

    // Drill into `add` only. `mul` stays cold.
    const r = collector();
    await s.resolveBody(add.id, r.sink);
    applyAll(store, r.deltas);
    expect(s.hotBodyIds()).toEqual([add.id]);
    const hotAdd = allNodes(store.snapshot()).find((n) => n.id === add.id)!;
    expect(hotAdd.detail).toBeDefined(); // add is hot
    const cfgId = deriveGraphId({ domain: 'code', source: 'add.ts', path: ['add'] }) as string;
    expect(store.snapshot().graphs.has(cfgId as never)).toBe(true);
    // The eager graphs (module / decl containment). A body edit must touch NONE
    // of them — only add's own detail subtree (which is store-only, not eager).
    const eagerGraphIds = new Set(s.document().graphs.map((g) => g.id));

    // (a) Whitespace edit: `add` re-materializes but is identical, `mul` cold ⇒ EMPTY.
    const ws = collector();
    await s.update({ path: 'add.ts', newText: '\n' + TS_ADD }, ws.sink);
    expect(ws.deltas[0]!.ops).toHaveLength(0);
    applyAll(store, ws.deltas);
    expect(s.hotBodyIds()).toEqual([add.id]); // mul never resolved

    // (b) Substantive body edit to `add`: a non-empty delta confined to add's subtree.
    const edited = ('\n' + TS_ADD).replace('return a + b;', 'return a + b + 1;');
    const be = collector();
    await s.update({ path: 'add.ts', newText: edited }, be.sink);
    const ops = be.deltas[0]!.ops as { graph?: string }[];
    expect(ops.length).toBeGreaterThan(0);
    for (const op of ops) {
      expect(eagerGraphIds.has(op.graph!), `op on ${op.graph} touched an eager graph`).toBe(false);
    }
    applyAll(store, be.deltas);
    // The whole space is still gate-valid after the composed edit.
    expect(decode(encode(store.snapshot()), { vocabulary }).ok).toBe(true);
    // `mul` is still cold — an edit never eagerly materializes an unvisited body.
    expect(nodeByLabel(store.snapshot(), 'code:function', 'mul').detail).toBeUndefined();
  });

  it('tears a hot body down when its function is renamed away', async () => {
    const s = await session([{ path: 'add.ts', text: TS_ADD }]);
    const store = storeOf(s);
    const add = nodeByLabel(store.snapshot(), 'code:function', 'add');
    const r = collector();
    await s.resolveBody(add.id, r.sink);
    applyAll(store, r.deltas);
    const cfgId = deriveGraphId({ domain: 'code', source: 'add.ts', path: ['add'] }) as string;
    expect(store.snapshot().graphs.has(cfgId as never)).toBe(true);

    const edited = TS_ADD.replace(/add/g, 'sum');
    const u = collector();
    await s.update({ path: 'add.ts', newText: edited }, u.sink);
    applyAll(store, u.deltas); // the composed teardown+eager delta must stay valid
    expect(store.snapshot().graphs.has(cfgId as never)).toBe(false); // body torn down
    expect(s.hotBodyIds()).toEqual([]); // `sum` is cold (a new identity)
    expect(decode(encode(store.snapshot()), { vocabulary }).ok).toBe(true);
  });
});

// ------------------------------------------------- add / delete / syntax-error

describe('7G incremental — file add, delete, and syntax-error edits', () => {
  it('adds a new module graph when a code file appears', async () => {
    const s = await session([{ path: 'a.ts', text: TS_ADD }]);
    const store = storeOf(s);
    const before = store.snapshot().graphs.size;
    const { sink, deltas } = collector();
    await s.update({ path: 'b.ts', newText: 'export function b(): void {}\n' }, sink);
    applyAll(store, deltas);
    expect(store.snapshot().graphs.size).toBeGreaterThan(before);
    expect(nodeByLabel(store.snapshot(), 'code:module', 'b.ts').id).toBeDefined();
    expect(nodeByLabel(store.snapshot(), 'code:function', 'b').id).toBeDefined();
  });

  it('removes a module when a file is deleted (newText absent)', async () => {
    const s = await session([{ path: 'a.ts', text: TS_ADD }, { path: 'b.ts', text: 'export function b(): void {}\n' }]);
    const store = storeOf(s);
    expect(allNodes(store.snapshot()).some((n) => n.label === 'b')).toBe(true);
    const { sink, deltas } = collector();
    await s.update({ path: 'b.ts' }, sink); // deletion
    applyAll(store, deltas);
    expect(allNodes(store.snapshot()).some((n) => n.label === 'b.ts')).toBe(false);
    expect(allNodes(store.snapshot()).some((n) => n.label === 'add')).toBe(true); // a.ts intact
    expect(decode(encode(store.snapshot()), { vocabulary }).ok).toBe(true);
  });

  it('keeps a partial, flagged graph when an edit introduces a syntax error', async () => {
    const s = await session([{ path: 'a.ts', text: TS_ADD }]);
    const store = storeOf(s);
    const broken = TS_ADD.replace('return a + b;', 'return a + ;'); // parse error
    const { sink, deltas } = collector();
    await s.update({ path: 'a.ts', newText: broken }, sink);
    applyAll(store, deltas); // error-tolerant: a valid, applicable delta, no throw
    const mod = allNodes(store.snapshot()).find((n) => n.kind === 'code:module')!;
    const full = store.snapshot();
    const modNode = [...full.graphs.values()].flatMap((g) => [...g.nodes.values()]).find((n) => n.id === mod.id)!;
    expect(modNode.attrs['code:parse-error']).toBe(true); // flagged partial
    expect(decode(encode(full), { vocabulary }).ok).toBe(true);
  });
});
