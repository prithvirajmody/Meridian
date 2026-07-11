/**
 * Node-side {@link GrammarSource}: reads the vendored grammar wasm from
 * `grammars/` via `node:fs`. Lives in `test/` (not `src/`) because adapters
 * are isomorphic — `src` may not import `node:*` (depcruise rule
 * `adapters-no-node-builtins`); the environment owns byte acquisition.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRAMMAR_FILES, type CodeLanguage, type GrammarSource } from '../src/index.js';

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const GRAMMARS_DIR = resolve(PACKAGE_ROOT, 'grammars');

export function grammarPath(language: CodeLanguage): string {
  return resolve(GRAMMARS_DIR, GRAMMAR_FILES[language]);
}

export const nodeGrammarSource: GrammarSource = async (language) =>
  new Uint8Array(await readFile(grammarPath(language)));
