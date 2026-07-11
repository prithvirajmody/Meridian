/**
 * Mixed-language directory ingest (7D exit criterion): one project tree holding
 * both TypeScript and Python files ingests into a single valid, deterministic
 * graph. Language routing is per-file (plugin.languageFor); the assembled
 * document is one project → package → module tree over both languages.
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
  { path: 'ts/shapes.ts', text: 'export class Circle { area(): number { return 0; } }\nexport function scale(k: number): number { return k; }\n' },
  { path: 'py/shapes.py', text: 'class Vector:\n    def add(self, o): pass\ndef dot(a, b) -> float:\n    return 0.0\n' },
  { path: 'py/pkg/__init__.py', text: 'def hello() -> str:\n    return "h"\n' },
  { path: 'index.ts', text: "export const version = '1';\n" },
];

const vocabulary: VocabularyRegistry = {
  attrs: new Map(Object.entries(codeManifest.attrSchemas ?? {}).map(([k, s]) => [k, s.type])),
  kinds: new Set(codeManifest.kinds ?? []),
};

const mapper: CodeMapper = inProcessMapper();
afterAll(() => mapper.dispose());

async function ingest(root: string): Promise<GraphDocument> {
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

describe('mixed-language ingest (TS + Python)', () => {
  it('produces one gate-clean graph with modules of both languages', async () => {
    const gate = decode(await ingest('mixed'), { vocabulary });
    expect(gate.ok ? [] : gate.errors).toEqual([]);
    if (!gate.ok) return;
    const langs = new Set<unknown>();
    let tsClass = false;
    let pyClass = false;
    for (const g of gate.space.graphs.values()) {
      for (const n of g.nodes.values()) {
        if (n.kind === 'code:module') langs.add(n.attrs['code:language']);
        if (n.kind === 'code:class' && n.label === 'Circle') tsClass = true;
        if (n.kind === 'code:class' && n.label === 'Vector') pyClass = true;
      }
    }
    expect(langs).toEqual(new Set(['typescript', 'python']));
    expect(tsClass && pyClass).toBe(true);
  });

  it('mixed ingest is byte-deterministic across two runs (I6)', async () => {
    const a = decode(await ingest('mixed'));
    const b = decode(await ingest('mixed'));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(encodeCanonical(b.space)).toBe(encodeCanonical(a.space));
  });
});
