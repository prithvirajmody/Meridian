/**
 * Python ID coordinates & discriminators (7D, ADR-0028): overload #hash
 * behavior, duplicate ~n, binding-name identity, and package/module/decl
 * coordinates in the assembled document. The discriminator *algebra*
 * (assignSegments/signatureHash) is language-agnostic and covered by
 * id-stability.test.ts; here we prove it holds over real Python trees end to
 * end, and that Python coordinates land where ADR-0028 says.
 */
import { decode, type GraphDocument, type VocabularyRegistry } from '@meridian/graph-core';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CODE_PROJECT_MEDIA_TYPE,
  codeManifest,
  createCodePlugin,
  encodeProjectBundle,
  type BundleFile,
  type CodeMapper,
} from '../src/index.js';
import { inProcessMapper, testContext } from './support.js';

const vocabulary: VocabularyRegistry = {
  attrs: new Map(Object.entries(codeManifest.attrSchemas ?? {}).map(([k, s]) => [k, s.type])),
  kinds: new Set(codeManifest.kinds ?? []),
};

const mapper: CodeMapper = inProcessMapper();
afterAll(() => mapper.dispose());

async function ingest(root: string, files: readonly BundleFile[]): Promise<GraphDocument> {
  const plugin = createCodePlugin({ mapper });
  const parser = plugin.activate(testContext()).parsers![0]!;
  const docs: GraphDocument[] = [];
  await parser.ingest(
    { uri: root, mediaType: CODE_PROJECT_MEDIA_TYPE, text: encodeProjectBundle({ root, files }) },
    { emitDocument: (d) => docs.push(d), emitDelta: () => undefined, progress: () => undefined },
  );
  return docs[0]!;
}

interface Flat {
  readonly kindsByLabel: Map<string, string[]>;
  readonly kinds: Set<string>;
  readonly labelsByKind: Map<string, string[]>;
  readonly nodeAttrs: Map<string, Record<string, unknown>>;
}

function flatten(doc: GraphDocument): Flat {
  const gate = decode(doc, { vocabulary });
  if (!gate.ok) throw new Error('gate failed: ' + JSON.stringify(gate.errors));
  const kindsByLabel = new Map<string, string[]>();
  const labelsByKind = new Map<string, string[]>();
  const nodeAttrs = new Map<string, Record<string, unknown>>();
  const kinds = new Set<string>();
  for (const g of gate.space.graphs.values()) {
    for (const n of g.nodes.values()) {
      kinds.add(n.kind);
      (kindsByLabel.get(n.label) ?? kindsByLabel.set(n.label, []).get(n.label)!).push(n.kind);
      (labelsByKind.get(n.kind) ?? labelsByKind.set(n.kind, []).get(n.kind)!).push(n.label);
      nodeAttrs.set(`${n.kind}:${n.label}:${n.id}`, n.attrs as Record<string, unknown>);
    }
  }
  return { kindsByLabel, kinds, labelsByKind, nodeAttrs };
}

describe('Python document — kinds, coordinates, discriminators', () => {
  it('emits project → package → module → class/function/method', async () => {
    const doc = await ingest('pkg', [
      { path: 'shapes/__init__.py', text: 'def hello() -> str:\n    return "s"\n' },
      { path: 'shapes/vectors.py', text: 'class Vector:\n    def add(self): pass\n' },
      { path: 'top.py', text: 'def free(): pass\n' },
    ]);
    const f = flatten(doc);
    expect(f.kinds).toContain('code:project');
    expect(f.kinds).toContain('code:package');
    expect(f.kinds).toContain('code:module');
    expect(f.kinds).toContain('code:class');
    expect(f.kinds).toContain('code:function');
    expect(f.kinds).toContain('code:method');
    // A directory with __init__.py is a code:package; __init__.py is a code:module.
    expect(f.labelsByKind.get('code:package')).toContain('shapes');
    expect(f.labelsByKind.get('code:module')).toContain('__init__.py');
    expect(f.labelsByKind.get('code:module')).toContain('vectors.py');
  });

  it('a nested package nests as code:package inside code:package', async () => {
    const doc = await ingest('pkg', [
      { path: 'shapes/__init__.py', text: 'x = 1\n' },
      { path: 'shapes/inner/__init__.py', text: 'async def deep() -> int:\n    return 42\n' },
    ]);
    const f = flatten(doc);
    expect(f.labelsByKind.get('code:package')?.sort()).toEqual(['inner', 'shapes']);
    // The async function inside the nested package is present and flagged async.
    const deep = [...f.nodeAttrs.entries()].find(([k]) => k.startsWith('code:function:deep:'));
    expect(deep).toBeDefined();
    expect(deep![1]['code:async']).toBe(true);
  });

  it('overloads get distinct IDs; a true duplicate gets ~n and the duplicate flag', async () => {
    const doc = await ingest('m', [
      {
        path: 'o.py',
        text: [
          'from typing import overload',
          '@overload',
          'def parse(x: int) -> str: ...',
          '@overload',
          'def parse(x: str) -> int: ...',
          'def parse(x): return x',
          'def dup(a: str) -> None: pass',
          'def dup(a: str) -> None: pass',
        ].join('\n') + '\n',
      },
    ]);
    const f = flatten(doc);
    // Three distinct parse nodes (unique IDs) + two dup nodes.
    const parseAttrs = [...f.nodeAttrs.entries()].filter(([k]) => k.startsWith('code:function:parse:'));
    expect(parseAttrs).toHaveLength(3);
    // At least the two @overload stubs are flagged.
    expect(parseAttrs.filter(([, a]) => a['code:overload'] === true).length).toBe(2);
    const dupAttrs = [...f.nodeAttrs.entries()].filter(([k]) => k.startsWith('code:function:dup:'));
    expect(dupAttrs).toHaveLength(2);
    expect(dupAttrs.every(([, a]) => a['code:duplicate'] === true)).toBe(true);
  });

  it('binding-name identity: a module-level lambda is a function named for its binding', async () => {
    const doc = await ingest('m', [{ path: 'b.py', text: 'scale = lambda v, k: v * k\nX = 1\n' }]);
    const f = flatten(doc);
    expect(f.labelsByKind.get('code:function')).toEqual(['scale']);
  });

  it('no-op re-ingest yields identical node IDs (U4 / §7.4)', async () => {
    const files: BundleFile[] = [
      { path: 'shapes/__init__.py', text: 'def hello(): pass\n' },
      { path: 'shapes/vectors.py', text: 'class V:\n    def add(self): pass\n' },
    ];
    const ids = async (): Promise<string[]> => {
      const g = decode(await ingest('pkg', files));
      if (!g.ok) throw new Error('gate failed');
      const out: string[] = [];
      for (const graph of g.space.graphs.values()) for (const n of graph.nodes.values()) out.push(n.id as string);
      return out.sort();
    };
    expect(await ids()).toEqual(await ids());
  });
});
