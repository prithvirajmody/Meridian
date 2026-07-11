/**
 * The one grammar-loading shim (ROADMAP Phase 7 §9b: "grammar/WASM operational
 * pain across Node+browser — contained by loading grammars through one shim
 * with its own tests"). Isomorphic: no `node:*`, no DOM — the environment
 * supplies grammar bytes through {@link GrammarSource} (Node: `fs` in a test/
 * entry shim; browser: `fetch`), and may supply the tree-sitter *runtime*
 * `.wasm` through Emscripten's `locateFile`/`wasmBinary` (in Node,
 * web-tree-sitter locates its own copy; the runtime wasm is deliberately NOT
 * vendored — it must match the pinned web-tree-sitter JS glue exactly).
 *
 * Every failure path throws a located, useful error naming the language and
 * the failing stage (roadmap failure-case row: "grammar load failure").
 */
import { Language, Parser } from 'web-tree-sitter';
import { GRAMMAR_FILES, type CodeLanguage } from './languages.js';

/** Supplies the vendored grammar bytes for a language (environment-owned). */
export type GrammarSource = (language: CodeLanguage) => Promise<Uint8Array>;

export interface ParserRuntimeOptions {
  readonly readGrammar: GrammarSource;
  /** Emscripten override: where to fetch `tree-sitter.wasm` (browser). */
  readonly locateFile?: (path: string, prefix: string) => string;
  /** Emscripten override: the runtime wasm bytes directly. */
  readonly wasmBinary?: Uint8Array;
}

/** A loaded tree-sitter runtime with per-language grammar caching. */
export interface ParserRuntime {
  /** Load (and cache) the grammar for `language`. Idempotent. */
  language(language: CodeLanguage): Promise<Language>;
  /** A parser with `language`'s grammar set. Caller owns `.delete()`. */
  parser(language: CodeLanguage): Promise<Parser>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Initialize the tree-sitter WASM runtime once and return the grammar-loading
 * shim. One runtime per JS realm (main thread or worker); the architecture
 * gate "grammars only loaded in workers" is enforced by *hosting* (worker.ts),
 * not by this function.
 */
export async function createParserRuntime(options: ParserRuntimeOptions): Promise<ParserRuntime> {
  try {
    const init: Record<string, unknown> = {};
    if (options.locateFile !== undefined) init['locateFile'] = options.locateFile;
    if (options.wasmBinary !== undefined) init['wasmBinary'] = options.wasmBinary;
    await Parser.init(init);
  } catch (error) {
    throw new Error(
      `adapter-code: tree-sitter runtime failed to initialize (web-tree-sitter's runtime wasm ` +
        `missing or mismatched with its JS glue): ${describe(error)}`,
      { cause: error },
    );
  }

  const cache = new Map<CodeLanguage, Promise<Language>>();

  const load = (language: CodeLanguage): Promise<Language> => {
    const cached = cache.get(language);
    if (cached !== undefined) return cached;
    const loading = loadLanguage(language, options.readGrammar);
    cache.set(language, loading);
    // A failed load must not poison the cache: allow a retry after e.g. a
    // transient fetch failure in the browser.
    loading.catch(() => cache.delete(language));
    return loading;
  };

  return {
    language: load,
    async parser(language: CodeLanguage): Promise<Parser> {
      const grammar = await load(language);
      const parser = new Parser();
      parser.setLanguage(grammar);
      return parser;
    },
  };
}

async function loadLanguage(language: CodeLanguage, read: GrammarSource): Promise<Language> {
  const file = GRAMMAR_FILES[language];
  let bytes: Uint8Array;
  try {
    bytes = await read(language);
  } catch (error) {
    throw new Error(
      `adapter-code: could not read the vendored grammar for "${language}" (grammars/${file}): ` +
        describe(error),
      { cause: error },
    );
  }
  if (bytes.length === 0) {
    throw new Error(
      `adapter-code: the grammar source returned zero bytes for "${language}" (grammars/${file})`,
    );
  }
  try {
    return await Language.load(bytes);
  } catch (error) {
    throw new Error(
      `adapter-code: grammar for "${language}" (grammars/${file}, ${bytes.length} bytes) is not a ` +
        `loadable tree-sitter grammar — corrupt vendored file or tree-sitter ABI mismatch with the ` +
        `pinned web-tree-sitter: ${describe(error)}`,
      { cause: error },
    );
  }
}
