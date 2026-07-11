/**
 * The Phase-7 language registry (ROADMAP Phase 7 §1: TypeScript and Python
 * first). Each language maps to one vendored WASM grammar under `grammars/`;
 * see `grammars/MANIFEST.md` for provenance and the regeneration command.
 * More languages are plugin-sized additions later (roadmap §10), not edits
 * to consumers of this table.
 */

export type CodeLanguage = 'typescript' | 'python';

export const CODE_LANGUAGES: readonly CodeLanguage[] = ['typescript', 'python'];

/** Vendored grammar file name (relative to the package's `grammars/` dir). */
export const GRAMMAR_FILES: Readonly<Record<CodeLanguage, string>> = {
  typescript: 'tree-sitter-typescript.wasm',
  python: 'tree-sitter-python.wasm',
};

export function isCodeLanguage(value: string): value is CodeLanguage {
  return (CODE_LANGUAGES as readonly string[]).includes(value);
}
