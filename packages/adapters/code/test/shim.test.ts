/**
 * 7B smoke: the shim loads both vendored grammars in Node and parses; grammar
 * load failure yields a useful, located error (SUBPHASES §7B test rows 1–2).
 */
import { describe, expect, it } from 'vitest';
import { CODE_LANGUAGES, createParserRuntime, parseSource } from '../src/index.js';
import { nodeGrammarSource } from './node-grammar-source.js';

const EXPECTED_ROOT: Record<string, string> = {
  typescript: 'program',
  python: 'module',
};

const HELLO: Record<string, string> = {
  typescript: 'export function greet(name: string): string {\n  return `hello ${name}`;\n}\n',
  python: 'def greet(name):\n    return f"hello {name}"\n',
};

describe('grammar-loading shim (Node)', () => {
  it('loads both vendored grammars and parses a hello-world in each', async () => {
    const runtime = await createParserRuntime({ readGrammar: nodeGrammarSource });
    for (const language of CODE_LANGUAGES) {
      const parser = await runtime.parser(language);
      const { tree, outcome } = parseSource(parser, language, HELLO[language]!);
      expect(outcome.rootType).toBe(EXPECTED_ROOT[language]);
      expect(outcome.hasErrors).toBe(false);
      expect(outcome.errorCount).toBe(0);
      expect(outcome.nodeCount).toBeGreaterThan(5);
      tree.delete();
      parser.delete();
    }
  });

  it('caches grammar loads per language (one read per language)', async () => {
    const reads: string[] = [];
    const runtime = await createParserRuntime({
      readGrammar: (language) => {
        reads.push(language);
        return nodeGrammarSource(language);
      },
    });
    await runtime.language('typescript');
    await runtime.language('typescript');
    const first = await runtime.parser('typescript');
    const second = await runtime.parser('typescript');
    expect(reads).toEqual(['typescript']);
    first.delete();
    second.delete();
  });

  it('grammar source failure → error naming the language and file, with cause', async () => {
    const runtime = await createParserRuntime({
      readGrammar: () => Promise.reject(new Error('ENOENT: disk on fire')),
    });
    const failure = await runtime.language('python').catch((e: unknown) => e as Error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('"python"');
    expect((failure as Error).message).toContain('grammars/tree-sitter-python.wasm');
    expect((failure as Error).message).toContain('disk on fire');
  });

  it('corrupt grammar bytes → error naming language, file, and byte count', async () => {
    const runtime = await createParserRuntime({
      readGrammar: () => Promise.resolve(new Uint8Array([0xde, 0xad, 0xbe, 0xef])),
    });
    const failure = await runtime.language('typescript').catch((e: unknown) => e as Error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('"typescript"');
    expect((failure as Error).message).toContain('4 bytes');
    expect((failure as Error).message).toContain('ABI mismatch');
  });

  it('zero-byte grammar source → explicit error (not a cryptic wasm failure)', async () => {
    const runtime = await createParserRuntime({
      readGrammar: () => Promise.resolve(new Uint8Array(0)),
    });
    await expect(runtime.language('typescript')).rejects.toThrow('zero bytes');
  });

  it('a failed load does not poison the cache: retry succeeds', async () => {
    let attempt = 0;
    const runtime = await createParserRuntime({
      readGrammar: (language) => {
        attempt++;
        return attempt === 1
          ? Promise.reject(new Error('transient'))
          : nodeGrammarSource(language);
      },
    });
    await expect(runtime.language('python')).rejects.toThrow('transient');
    const grammar = await runtime.language('python');
    expect(grammar.abiVersion).toBeGreaterThanOrEqual(14);
  });
});
