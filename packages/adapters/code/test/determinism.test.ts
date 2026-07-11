/**
 * Byte-determinism, no-op re-ingest identity, and document structure (7C exit
 * criterion + ROADMAP §12 rows). Drives the real plugin through a buffered sink
 * (as a host does), then gates the output with graph-core's IR gate against the
 * adapter's declared vocabulary (U8).
 */
import {
  decode,
  encodeCanonical,
  type GraphDocument,
  type VocabularyRegistry,
} from '@meridian/graph-core';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CODE_PROJECT_MEDIA_TYPE,
  codeManifest,
  createCodePlugin,
  encodeProjectBundle,
  type CodeMapper,
} from '../src/index.js';
import { inProcessMapper, testContext } from './support.js';

const FILES = [
  {
    path: 'src/shapes.ts',
    text: 'export class Circle {\n  constructor(public r: number) {}\n  area(): number { return this.r; }\n  static unit(): Circle { return new Circle(1); }\n}\nexport function twice(a: string): void;\nexport function twice(a: number): void;\nexport function twice(a: unknown): void {}\nexport const scale = (c: Circle, k: number) => new Circle(c.r * k);\nexport default function main(): void {}\n',
  },
  { path: 'index.ts', text: "export const version = '1';\nexport function greet(name: string): string { return name; }\n" },
];

const vocabulary: VocabularyRegistry = {
  attrs: new Map(Object.entries(codeManifest.attrSchemas ?? {}).map(([k, s]) => [k, s.type])),
  kinds: new Set(codeManifest.kinds ?? []),
};

const mapper: CodeMapper = inProcessMapper();
afterAll(() => mapper.dispose());

async function ingestBundle(root: string): Promise<GraphDocument> {
  const plugin = createCodePlugin({ mapper });
  const parser = plugin.activate(testContext()).parsers![0]!;
  const docs: GraphDocument[] = [];
  await parser.ingest(
    { uri: root, mediaType: CODE_PROJECT_MEDIA_TYPE, text: encodeProjectBundle({ root, files: FILES }) },
    { emitDocument: (d) => docs.push(d), emitDelta: () => undefined, progress: () => undefined },
  );
  expect(docs).toHaveLength(1);
  return docs[0]!;
}

describe('code adapter — determinism & structure', () => {
  it('emits an IR-gate-clean document at eager levels', async () => {
    const gate = decode(await ingestBundle('demo'), { vocabulary });
    expect(gate.ok ? [] : gate.errors).toEqual([]);
    if (!gate.ok) return;
    const kinds = new Set<string>();
    for (const g of gate.space.graphs.values()) for (const n of g.nodes.values()) kinds.add(n.kind);
    expect(kinds).toContain('code:project');
    expect(kinds).toContain('code:package');
    expect(kinds).toContain('code:module');
    expect(kinds).toContain('code:class');
    expect(kinds).toContain('code:function');
    expect(kinds).toContain('code:method');
  });

  it('containment is the detail relation: 7C emits zero edges', async () => {
    const gate = decode(await ingestBundle('demo'), { vocabulary });
    expect(gate.ok).toBe(true);
    if (!gate.ok) return;
    let edges = 0;
    for (const g of gate.space.graphs.values()) edges += g.edges.size;
    expect(edges).toBe(0);
  });

  it('two ingests of the same project are byte-identical (I6)', async () => {
    const a = decode(await ingestBundle('demo'));
    const b = decode(await ingestBundle('demo'));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(encodeCanonical(b.space)).toBe(encodeCanonical(a.space));
  });

  it('no-op re-ingest yields identical node IDs (U4 / §7.4)', async () => {
    const ids = async (): Promise<string[]> => {
      const g = decode(await ingestBundle('demo'));
      if (!g.ok) throw new Error('gate failed');
      const out: string[] = [];
      for (const graph of g.space.graphs.values()) for (const n of graph.nodes.values()) out.push(n.id as string);
      return out.sort();
    };
    expect(await ids()).toEqual(await ids());
  });

  it('a single .ts file ingests as a one-module project', async () => {
    const plugin = createCodePlugin({ mapper });
    const parser = plugin.activate(testContext()).parsers![0]!;
    const docs: GraphDocument[] = [];
    await parser.ingest(
      { uri: 'solo.ts', text: 'export function only(): void {}' },
      { emitDocument: (d) => docs.push(d), emitDelta: () => undefined, progress: () => undefined },
    );
    const gate = decode(docs[0]!, { vocabulary });
    expect(gate.ok).toBe(true);
    if (!gate.ok) return;
    const kinds = [...gate.space.graphs.values()].flatMap((g) => [...g.nodes.values()].map((n) => n.kind));
    expect(kinds).toContain('code:project');
    expect(kinds).toContain('code:module');
    expect(kinds).toContain('code:function');
  });
});
