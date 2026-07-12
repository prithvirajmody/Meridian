/**
 * The `detail-resolver` seam end-to-end (7F, ADR-0027; ROADMAP §11 exit: "drill
 * into any function materializes CFG/AST < 150ms"). Ingests the code fixtures
 * through the plugin, decodes to a real store, and drives
 * {@link createCodeDetailResolver} over every cold function/method:
 *
 * - **laziness thresholds** — the eager graph has *no* body nodes/edges and the
 *   function is cold (no `detail`); it carries the `code:body-span` /
 *   `code:scope-path` markers (ADR-0027);
 * - **materialization** — one `resolve` emits a delta that applies and re-passes
 *   the IR gate, flipping the function hot with a CFG graph of `code:block`s +
 *   `code:flows-to` edges, each block's AST detail of `code:stmt`/`code:expr`;
 * - **byte-identity** — the detail graph id is exactly `deriveGraphId(function
 *   coords)` (what an eager materialization would use), and two resolves of the
 *   same cold node are byte-identical (deterministic / idempotent);
 * - **latency** — measured p95 < 150ms, reported.
 */
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decode,
  deriveGraphId,
  encode,
  type GraphSpace,
  type SemanticNode,
  type VocabularyRegistry,
} from '@meridian/graph-core';
import { createStore, decodeDeltaInput } from '@meridian/graph-store';
import type { DeltaWire, DetailContext, IdFacade, IngestSink } from '@meridian/plugin-api';
import { afterAll, describe, expect, it } from 'vitest';
import {
  canResolveCodeDetail,
  codeManifest,
  createCodeDetailResolver,
  createCodePlugin,
  DetailResolveError,
} from '../src/index.js';
import { inProcessMapper, testContext } from './support.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const mapper = inProcessMapper();
afterAll(() => mapper.dispose());

const ctx = testContext();
const ids: IdFacade = ctx.ids;
const detailCtx: DetailContext = { apiVersion: '0.2.0', log: { info: () => undefined, warn: () => undefined } };

const vocabulary: VocabularyRegistry = {
  kinds: new Set(codeManifest.kinds ?? []),
  attrs: new Map(Object.entries(codeManifest.attrSchemas ?? {}).map(([k, v]) => [k, v.type])),
};

function fixture(rel: string): string {
  return readFileSync(resolvePath(here, '../../../../fixtures/corpora', rel), 'utf8');
}

/** Ingest one file through the plugin; return its gated space + a source reader. */
async function ingestFile(uri: string, text: string): Promise<{ space: GraphSpace; readSource: (u: string) => string | undefined }> {
  const exports = createCodePlugin({ mapper }).activate(ctx);
  let doc: unknown;
  const sink: IngestSink = { emitDocument: (d) => (doc = d), emitDelta: () => undefined, progress: () => undefined };
  await exports.parsers![0]!.ingest({ uri, text }, sink);
  const decoded = decode(doc, { vocabulary });
  if (!decoded.ok) throw new Error(`eager ingest of ${uri} did not gate-decode: ${JSON.stringify(decoded.errors)}`);
  return { space: decoded.space, readSource: (u) => (u === uri ? text : undefined) };
}

function allNodes(space: GraphSpace): SemanticNode[] {
  const out: SemanticNode[] = [];
  for (const g of space.graphs.values()) for (const n of g.nodes.values()) out.push(n);
  return out;
}

function nodesOfKind(space: GraphSpace, kind: string): SemanticNode[] {
  return allNodes(space).filter((n) => n.kind === kind);
}

/** Resolve a cold node and apply its delta to a store; return the new space. */
async function resolveInto(
  space: GraphSpace,
  node: SemanticNode,
  readSource: (u: string) => string | undefined,
): Promise<{ space: GraphSpace; delta: DeltaWire; detailGraph: string }> {
  const resolver = createCodeDetailResolver({ mapper, ids, readSource });
  let delta: DeltaWire | undefined;
  const sink: IngestSink = { emitDocument: () => undefined, emitDelta: (d) => (delta = d), progress: () => undefined };
  const ref = await resolver.resolve(node as never, sink, detailCtx);
  const decoded = decodeDeltaInput(delta);
  if (!decoded.ok) throw new Error(`resolve delta did not decode: ${JSON.stringify(decoded.errors)}`);
  const store = createStore(space);
  const applied = store.apply(decoded.delta);
  if (!applied.ok) throw new Error(`resolve delta did not apply: ${JSON.stringify(applied.errors)}`);
  return { space: store.snapshot(), delta: delta!, detailGraph: ref.graph };
}

describe('DetailResolver — laziness thresholds (ADR-0027)', () => {
  it('the eager graph has no body nodes/edges and functions are cold', async () => {
    const { space } = await ingestFile('functions.ts', fixture('code-ts/functions.ts'));
    // ADR-0027: block/stmt/expr and flows-to are lazy — none at ingest.
    for (const n of allNodes(space)) {
      expect(['code:block', 'code:stmt', 'code:expr']).not.toContain(n.kind);
    }
    for (const g of space.graphs.values()) {
      for (const e of g.edges.values()) expect(e.kind).not.toBe('code:flows-to');
    }
    const add = nodesOfKind(space, 'code:function').find((n) => n.label === 'add')!;
    expect(add.detail).toBeUndefined(); // cold
    expect(add.attrs['code:body-span']).toBeDefined(); // canResolve marker
    expect(add.attrs['code:scope-path']).toEqual(['add']);
    expect(canResolveCodeDetail(add as never)).toBe(true);
  });

  it('canResolve is false for a hot node, a class, a module, and an abstract signature', async () => {
    const { space, readSource } = await ingestFile('classes.ts', fixture('code-ts/classes.ts'));
    expect(canResolveCodeDetail(nodesOfKind(space, 'code:class')[0]! as never)).toBe(false);
    expect(canResolveCodeDetail(nodesOfKind(space, 'code:module')[0]! as never)).toBe(false);
    // An abstract method / overload signature has no body-span ⇒ not resolvable.
    const bodyless = nodesOfKind(space, 'code:method').find((n) => n.attrs['code:body-span'] === undefined);
    if (bodyless !== undefined) expect(canResolveCodeDetail(bodyless as never)).toBe(false);
    const method = nodesOfKind(space, 'code:method').find((n) => n.attrs['code:body-span'] !== undefined)!;
    const { space: hot } = await resolveInto(space, method, readSource);
    const nowHot = allNodes(hot).find((n) => n.id === method.id)!;
    expect(nowHot.detail).toBeDefined();
    expect(canResolveCodeDetail(nowHot as never)).toBe(false); // already hot
  });
});

describe('DetailResolver — materialization & byte-identity', () => {
  it('drilling into a function materializes a gate-valid CFG + AST', async () => {
    const { space, readSource } = await ingestFile('functions.ts', fixture('code-ts/functions.ts'));
    const add = nodesOfKind(space, 'code:function').find((n) => n.label === 'add')!;
    const { space: hot, detailGraph } = await resolveInto(space, add, readSource);

    // The whole space still passes the IR gate after the resolve delta.
    const regated = decode(encode(hot), { vocabulary });
    expect(regated.ok).toBe(true);

    // The function is now hot, pointing at the CFG graph.
    const hotAdd = allNodes(hot).find((n) => n.id === add.id)!;
    expect(hotAdd.detail?.graph).toBe(detailGraph);

    // Byte-identity: the detail graph id is exactly deriveGraphId(fn coords).
    const expectedGraph = deriveGraphId({ domain: 'code', source: 'functions.ts', path: ['add'] });
    expect(detailGraph).toBe(expectedGraph as string);

    // The CFG graph has block nodes and flow edges; a block has AST detail.
    const cfg = hot.graphs.get(expectedGraph)!;
    const blocks = [...cfg.nodes.values()].filter((n) => n.kind === 'code:block');
    expect(blocks.length).toBeGreaterThanOrEqual(2); // entry + exit at least
    expect([...cfg.edges.values()].every((e) => e.kind === 'code:flows-to')).toBe(true);
    expect([...cfg.edges.values()].length).toBeGreaterThan(0);
    const blockWithAst = blocks.find((b) => b.detail !== undefined)!;
    const ast = hot.graphs.get(blockWithAst.detail!.graph)!;
    expect([...ast.nodes.values()].some((n) => n.kind === 'code:stmt')).toBe(true);
    // Body nodes are source-tagged, not AI (ADR-0027).
    expect([...cfg.nodes.values()].every((n) => n.provenance.origin === 'source')).toBe(true);
  });

  it('resolving the same cold node twice is byte-identical (deterministic/idempotent)', async () => {
    const { space, readSource } = await ingestFile('functions.py', fixture('code-py/functions.py'));
    const add = nodesOfKind(space, 'code:function').find((n) => n.label === 'add')!;
    const resolver = createCodeDetailResolver({ mapper, ids, readSource });
    const run = async (): Promise<DeltaWire> => {
      let delta: DeltaWire | undefined;
      await resolver.resolve(add as never, { emitDocument() {}, emitDelta: (d) => (delta = d), progress() {} }, detailCtx);
      return delta!;
    };
    expect(JSON.stringify(await run())).toBe(JSON.stringify(await run()));
  });

  it('a missing source is an honest located error, not a crash', async () => {
    const { space } = await ingestFile('functions.ts', fixture('code-ts/functions.ts'));
    const add = nodesOfKind(space, 'code:function').find((n) => n.label === 'add')!;
    const resolver = createCodeDetailResolver({ mapper, ids, readSource: () => undefined });
    await expect(
      resolver.resolve(add as never, { emitDocument() {}, emitDelta() {}, progress() {} }, detailCtx),
    ).rejects.toBeInstanceOf(DetailResolveError);
  });
});

describe('DetailResolver — drill into every fixture function < 150ms', () => {
  const files: Array<[string, string]> = [
    ['functions.ts', 'code-ts/functions.ts'],
    ['classes.ts', 'code-ts/classes.ts'],
    ['functions.py', 'code-py/functions.py'],
    ['classes.py', 'code-py/classes.py'],
  ];

  it('materializes each function/method body and reports latency', async () => {
    const timings: number[] = [];
    let count = 0;
    // Warm the grammar runtimes so the measured resolves exclude one-time init.
    await ingestFile('functions.ts', fixture('code-ts/functions.ts'));
    await ingestFile('functions.py', fixture('code-py/functions.py'));

    for (const [uri, rel] of files) {
      const { space, readSource } = await ingestFile(uri, fixture(rel));
      const targets = allNodes(space).filter((n) => canResolveCodeDetail(n as never));
      expect(targets.length).toBeGreaterThan(0);
      for (const node of targets) {
        const started = performance.now();
        const { space: hot, detailGraph } = await resolveInto(space, node, readSource);
        timings.push(performance.now() - started);
        count++;
        // Every drill-in produces a real, gate-valid CFG graph.
        const cfg = hot.graphs.get(detailGraph as never)!;
        expect(cfg).toBeDefined();
        expect([...cfg.nodes.values()].filter((n) => n.kind === 'code:block').length).toBeGreaterThanOrEqual(2);
        expect(decode(encode(hot), { vocabulary }).ok).toBe(true);
      }
    }

    timings.sort((a, b) => a - b);
    const p95 = timings[Math.min(timings.length - 1, Math.floor(timings.length * 0.95))]!;
    const max = timings[timings.length - 1]!;
    const mean = timings.reduce((a, b) => a + b, 0) / timings.length;
    console.log(
      `[7F] lazy resolve over ${count} fixture functions: mean ${mean.toFixed(2)}ms · p95 ${p95.toFixed(2)}ms · max ${max.toFixed(2)}ms`,
    );
    expect(p95).toBeLessThan(150);
  });
});
