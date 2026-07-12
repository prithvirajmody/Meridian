/**
 * Byte-determinism of Python ingest (7D exit criterion), mirroring the TS
 * determinism suite (determinism.test.ts). Drives the real plugin through a
 * buffered sink and gates output against the adapter's declared vocabulary (U8);
 * two ingests of the same Python project must be byte-identical.
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
    path: 'shapes/circle.py',
    text: [
      'import math',
      'class Circle:',
      '    def __init__(self, r: float):',
      '        self.r = r',
      '    def area(self) -> float:',
      '        return math.pi * self.r * self.r',
      '    @staticmethod',
      '    def unit() -> "Circle":',
      '        return Circle(1)',
      'def twice(a: str) -> None: pass',
      'def twice(a: int) -> None: pass',
      'scale = lambda c, k: Circle(c.r * k)',
    ].join('\n') + '\n',
  },
  { path: 'shapes/__init__.py', text: 'VERSION = "1"\ndef greet(name: str) -> str:\n    return name\n' },
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

describe('Python adapter — determinism & structure', () => {
  it('emits an IR-gate-clean document at eager levels', async () => {
    const gate = decode(await ingestBundle('demo'), { vocabulary });
    expect(gate.ok ? [] : gate.errors).toEqual([]);
    if (!gate.ok) return;
    const kinds = new Set<string>();
    for (const g of gate.space.graphs.values()) for (const n of g.nodes.values()) kinds.add(n.kind);
    for (const k of ['code:project', 'code:package', 'code:module', 'code:class', 'code:function', 'code:method']) {
      expect(kinds).toContain(k);
    }
  });

  it('containment stays the detail relation; 7E edges are code:calls/imports only', async () => {
    // `scale = lambda c, k: Circle(c.r * k)` resolves to the module-level class
    // `Circle` (tier 1) → one code:calls edge; every emitted edge is a 7E
    // import/call edge carrying code:confidence (never a containment edge).
    const gate = decode(await ingestBundle('demo'), { vocabulary });
    expect(gate.ok).toBe(true);
    if (!gate.ok) return;
    const edges = [...gate.space.graphs.values()].flatMap((g) => [...g.edges.values()]);
    expect(edges.length).toBeGreaterThan(0);
    for (const e of edges) {
      expect(['code:calls', 'code:imports']).toContain(e.kind);
      expect(e.attrs['code:confidence']).toBe('syntactic');
    }
    expect(edges.some((e) => e.kind === 'code:calls')).toBe(true);
  });

  it('two ingests of the same Python project are byte-identical (I6)', async () => {
    const a = decode(await ingestBundle('demo'));
    const b = decode(await ingestBundle('demo'));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(encodeCanonical(b.space)).toBe(encodeCanonical(a.space));
  });
});
