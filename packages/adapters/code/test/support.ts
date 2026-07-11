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
  createInProcessMapper,
  mapModuleTree,
  parseSource,
  createParserRuntime,
  type CodeLanguage,
  type CodeMapper,
  type ParserRuntime,
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
    apiVersion: '0.1.0',
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
