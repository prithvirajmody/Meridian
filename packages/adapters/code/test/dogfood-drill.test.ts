/**
 * Dogfood drill-in (ROADMAP Phase 7 §12 manual-exploratory / §13 "Meridian
 * renders Meridian"): ingest one of Meridian's **own** source files and drill
 * into a known function, materializing its CFG + AST on demand (ADR-0027). This
 * is the permanent, deterministic slice of the dogfood judgment — it reads a
 * committed real file (`../src/map/scan.ts`, `collectCalls`), so it always runs
 * and never churns, unlike a whole-monorepo golden. The wider "reads
 * truthfully at every level" judgment stays a human row in the checklist.
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
import type { DetailContext, IdFacade, IngestSink } from '@meridian/plugin-api';
import { afterAll, describe, expect, it } from 'vitest';
import {
  canResolveCodeDetail,
  CODE_PROJECT_MEDIA_TYPE,
  codeManifest,
  createCodeDetailResolver,
  createCodePlugin,
  encodeProjectBundle,
} from '../src/index.js';
import { inProcessMapper, testContext } from './support.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const mapper = inProcessMapper();
afterAll(() => mapper.dispose());

const ctx = testContext();
const ids: IdFacade = ctx.ids;
const detailCtx: DetailContext = { apiVersion: '1.0.0', log: { info: () => undefined, warn: () => undefined } };
const vocabulary: VocabularyRegistry = {
  kinds: new Set(codeManifest.kinds ?? []),
  attrs: new Map(Object.entries(codeManifest.attrSchemas ?? {}).map(([k, v]) => [k, v.type])),
};

// A real Meridian source file and a real function inside it.
const TARGET_URI = 'packages/adapters/code/src/map/scan.ts';
const TARGET_FN = 'collectCalls';
const source = readFileSync(resolvePath(here, '../src/map/scan.ts'), 'utf8');

function allNodes(space: GraphSpace): SemanticNode[] {
  const out: SemanticNode[] = [];
  for (const g of space.graphs.values()) for (const n of g.nodes.values()) out.push(n);
  return out;
}

async function ingest(): Promise<GraphSpace> {
  const exports = createCodePlugin({ mapper }).activate(ctx);
  let doc: unknown;
  const sink: IngestSink = { emitDocument: (d) => (doc = d), emitDelta: () => undefined, progress: () => undefined };
  // Ingest as a one-file project bundle so the module's source coordinate is the
  // full repo-relative path (a single-file source would collapse to a basename).
  const bundle = encodeProjectBundle({ root: 'meridian', files: [{ path: TARGET_URI, text: source }] });
  await exports.parsers![0]!.ingest({ uri: 'meridian', mediaType: CODE_PROJECT_MEDIA_TYPE, text: bundle }, sink);
  const decoded = decode(doc, { vocabulary });
  if (!decoded.ok) throw new Error(`dogfood ingest did not gate-decode: ${JSON.stringify(decoded.errors)}`);
  return decoded.space;
}

describe('dogfood — Meridian ingests its own source and drills into a function', () => {
  it(`eager ingest of ${TARGET_URI} exposes ${TARGET_FN} as a cold, resolvable function`, async () => {
    const space = await ingest();
    const fn = allNodes(space).find((n) => n.kind === 'code:function' && n.label === TARGET_FN);
    expect(fn, `${TARGET_FN} should be an eager function node`).toBeDefined();
    expect(fn!.detail).toBeUndefined(); // cold — body not materialized eagerly (ADR-0027)
    expect(fn!.attrs['code:body-span']).toBeDefined(); // canResolve marker
    expect(canResolveCodeDetail(fn! as never)).toBe(true);
  });

  it(`drilling into ${TARGET_FN} materializes CFG + AST < 150ms`, async () => {
    const space = await ingest();
    const fn = allNodes(space).find((n) => n.kind === 'code:function' && n.label === TARGET_FN)!;

    const resolver = createCodeDetailResolver({ mapper, ids, readSource: (u) => (u === TARGET_URI ? source : undefined) });
    let delta: unknown;
    const sink: IngestSink = { emitDocument: () => undefined, emitDelta: (d) => (delta = d), progress: () => undefined };
    const started = performance.now();
    const ref = await resolver.resolve(fn as never, sink, detailCtx);
    const ms = performance.now() - started;

    const decoded = decodeDeltaInput(delta);
    if (!decoded.ok) throw new Error(`resolve delta did not decode: ${JSON.stringify(decoded.errors)}`);
    const store = createStore(space);
    const applied = store.apply(decoded.delta);
    expect(applied.ok).toBe(true);
    const hot = store.snapshot();

    // Byte-identity (ADR-0027): the detail graph id is deriveGraphId(fn coords).
    const expectedGraph = deriveGraphId({ domain: 'code', source: TARGET_URI, path: [TARGET_FN] });
    expect(ref.graph).toBe(expectedGraph as string);

    // CFG: ≥ entry + exit blocks, all edges are flows-to; AST under a block.
    const cfg = hot.graphs.get(expectedGraph as never)!;
    const blocks = [...cfg.nodes.values()].filter((n) => n.kind === 'code:block');
    const flows = [...cfg.edges.values()];
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    expect(flows.length).toBeGreaterThan(0);
    expect(flows.every((e) => e.kind === 'code:flows-to')).toBe(true);
    const astBlock = blocks.find((b) => b.detail !== undefined)!;
    const ast = hot.graphs.get(astBlock.detail!.graph)!;
    const stmts = [...ast.nodes.values()].filter((n) => n.kind === 'code:stmt' || n.kind === 'code:expr');
    expect(stmts.length).toBeGreaterThan(0);

    // Still gate-valid, and body nodes are source-tagged (not AI).
    expect(decode(encode(hot), { vocabulary }).ok).toBe(true);
    expect([...cfg.nodes.values()].every((n) => n.provenance.origin === 'source')).toBe(true);

    console.log(
      `[7H dogfood] drill ${TARGET_URI}::${TARGET_FN} → ${blocks.length} CFG blocks, ${flows.length} flow edges, ${stmts.length} AST stmt/expr nodes in ${ms.toFixed(1)}ms`,
    );
    expect(ms).toBeLessThan(150);
  });
});
