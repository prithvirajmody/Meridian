/**
 * Shared test scaffolding (outside `src/`, so it may touch `node:*` and
 * graph-core — the adapters-no-node-builtins rule is a `src` rule): an
 * in-process mapper over the vendored grammars, and a `PluginContext` backed by
 * graph-core's real ID derivation (what the CLI/host inject in production).
 */
import {
  deriveEdgeId,
  deriveGraphId,
  deriveNodeId,
  type GraphId,
  type NodeId,
} from '@meridian/graph-core';
import type { PluginContext } from '@meridian/plugin-api';
import {
  buildBody,
  createInProcessMapper,
  mapModuleTree,
  parseSource,
  createParserRuntime,
  type CodeLanguage,
  type CodeMapper,
  type ParserRuntime,
  type RawBody,
  type RawDecl,
  type RawModule,
} from '../src/index.js';
import { nodeGrammarSource } from './node-grammar-source.js';

let runtime: Promise<ParserRuntime> | undefined;

/** Parse + map one source of `language` on the main thread (tests only). */
async function mapOne(language: CodeLanguage, source: string, text: string): Promise<RawModule> {
  runtime ??= createParserRuntime({ readGrammar: nodeGrammarSource });
  const parser = await (await runtime).parser(language);
  try {
    const { tree } = parseSource(parser, language, text);
    try {
      return mapModuleTree(tree, language, { source, label: source });
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}

/** Depth-first find of the first declaration named `name` (methods included). */
function findDecl(decls: readonly RawDecl[], name: string): RawDecl | undefined {
  for (const d of decls) {
    if (d.name === name) return d;
    const nested = findDecl(d.children, name);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/** Parse `text`, locate the function/method `name`, and materialize its
 * {@link RawBody} (7F). The eager decl span is exactly the resolver's input. */
export async function resolveBodyByName(
  language: CodeLanguage,
  text: string,
  name: string,
): Promise<RawBody> {
  runtime ??= createParserRuntime({ readGrammar: nodeGrammarSource });
  const parser = await (await runtime).parser(language);
  try {
    const { tree } = parseSource(parser, language, text);
    try {
      const module = mapModuleTree(tree, language, { source: `mem.${language === 'python' ? 'py' : 'ts'}`, label: 'mem' });
      const decl = findDecl(module.decls, name);
      if (decl === undefined || decl.bodySpan === undefined) {
        throw new Error(`no body-bearing declaration named "${name}"`);
      }
      const body = buildBody(tree, language, decl.span);
      if (body === undefined) throw new Error(`buildBody found no body for "${name}"`);
      return body;
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}

/** A canonical, ordinal-stable summary of a CFG for hand-drawn truth tests:
 * block `key:role` set (sorted) and `from->to:label` flow set (sorted). */
export function cfgSummary(body: RawBody): { blocks: string[]; flows: string[] } {
  return {
    blocks: body.blocks.map((b) => `${b.key}:${b.role}`).sort(),
    flows: body.flows.map((f) => `${f.from}->${f.to}:${f.label}`).sort(),
  };
}

/** Parse `text` and materialize the body of the declaration at `declSpan` on
 * the main thread (worker-parity tests, 7F). */
export async function resolveBodyBySpan(
  language: CodeLanguage,
  text: string,
  declSpan: readonly [number, number],
): Promise<RawBody | undefined> {
  runtime ??= createParserRuntime({ readGrammar: nodeGrammarSource });
  const parser = await (await runtime).parser(language);
  try {
    const { tree } = parseSource(parser, language, text);
    try {
      return buildBody(tree, language, declSpan);
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}

/** Parse + map one TypeScript source on the main thread (tests only). */
export function mapTs(source: string, text: string): Promise<RawModule> {
  return mapOne('typescript', source, text);
}

/** Parse + map one Python source on the main thread (tests only). */
export function mapPy(source: string, text: string): Promise<RawModule> {
  return mapOne('python', source, text);
}

export function inProcessMapper(): CodeMapper {
  return createInProcessMapper({ readGrammar: nodeGrammarSource });
}

export function testContext(): PluginContext {
  return {
    apiVersion: '0.2.0',
    ids: {
      nodeId: (c) => deriveNodeId(c) as string,
      graphId: (c) => deriveGraphId(c) as string,
      edgeId: (c) =>
        deriveEdgeId({
          graph: c.graph as GraphId,
          kind: c.kind,
          src: c.src as NodeId,
          dst: c.dst as NodeId,
          ...(c.occurrence !== undefined ? { occurrence: c.occurrence } : {}),
        }) as string,
    },
    log: { info: () => undefined, warn: () => undefined },
  };
}
