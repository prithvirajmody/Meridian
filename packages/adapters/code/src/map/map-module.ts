/**
 * The one language→walk dispatch (7D). Both mapper hosts (in-process and worker,
 * {@link ../mapper.js}, {@link ../worker/worker-api.js}) route a parsed tree to
 * its language's walk here, so the routing lives in exactly one place — the only
 * seam TS and Python genuinely share at the walk level (SUBPHASES §7D: factor
 * only where it repeats). The per-language walks stay separate: their signature
 * extraction is grammar-shaped and does not overlap.
 */
import type { Tree } from 'web-tree-sitter';
import type { CodeLanguage } from '../languages.js';
import type { RawModule } from './raw.js';
import { mapPythonModule } from './python.js';
import { mapTypeScriptModule } from './typescript.js';

export interface MapModuleOptions {
  /** Repository-relative POSIX path — the ADR-0028 `source` coordinate. */
  readonly source: string;
  /** Display label (basename). */
  readonly label: string;
}

/** Map a parsed tree to its {@link RawModule} skeleton by language. */
export function mapModuleTree(tree: Tree, language: CodeLanguage, opts: MapModuleOptions): RawModule {
  switch (language) {
    case 'typescript':
      return mapTypeScriptModule(tree, opts);
    case 'python':
      return mapPythonModule(tree, opts);
  }
}
