/**
 * Assemble mapped modules into the project → package → module containment tree
 * (ROADMAP §7 levels). A directory is a `code:package`; the ingest root is the
 * `code:project`; a file is a `code:module`. Purely structural and
 * deterministic: children are sorted by their POSIX path so serialization is
 * byte-stable regardless of discovery order.
 */
import type { RawModule } from './raw.js';

/** A directory in the containment tree (the project root, or a package). */
export interface RawDir {
  /** Basename (display label). */
  readonly name: string;
  /** POSIX path used as the ADR-0002 `source` coordinate: the project's own
   * name for the root, the repo-relative directory path for a package. */
  readonly source: string;
  readonly dirs: readonly RawDir[];
  readonly modules: readonly RawModule[];
}

interface MutableDir {
  name: string;
  source: string;
  dirs: Map<string, MutableDir>;
  modules: RawModule[];
}

function freeze(dir: MutableDir): RawDir {
  const dirs = [...dir.dirs.values()]
    .map(freeze)
    .sort((a, b) => a.source.localeCompare(b.source));
  const modules = [...dir.modules].sort((a, b) => a.source.localeCompare(b.source));
  return { name: dir.name, source: dir.source, dirs, modules };
}

/**
 * Build the project's root directory from mapped modules. `projectName` is the
 * ingest-root basename and becomes the root `source`/label; each module's
 * `source` is its repo-relative POSIX path (`src/util/foo.ts`).
 */
export function assembleProject(projectName: string, modules: readonly RawModule[]): RawDir {
  const root: MutableDir = { name: projectName, source: projectName, dirs: new Map(), modules: [] };
  for (const module of modules) {
    const segments = module.source.split('/');
    const fileName = segments.pop()!;
    void fileName;
    let dir = root;
    const acc: string[] = [];
    for (const segment of segments) {
      acc.push(segment);
      const source = acc.join('/');
      let child = dir.dirs.get(segment);
      if (child === undefined) {
        child = { name: segment, source, dirs: new Map(), modules: [] };
        dir.dirs.set(segment, child);
      }
      dir = child;
    }
    dir.modules.push(module);
  }
  return freeze(root);
}
