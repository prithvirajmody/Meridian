/**
 * Project-bundle wire form. The plugin contract's {@link SourceDescriptor} is
 * one blob (ADR-0009: parsers see text/bytes, never the filesystem), but a code
 * project is many files. The composition root (the CLI) resolves the directory
 * I/O and hands the adapter a single descriptor whose `text` is this bundle and
 * whose `mediaType` is {@link CODE_PROJECT_MEDIA_TYPE}. A lone `.ts` file is
 * still valid input (a one-module project) — no bundle needed.
 */

export const CODE_PROJECT_MEDIA_TYPE = 'application/vnd.meridian.code-project+json';

/** One file in a project bundle: a repo-relative POSIX path and its text. */
export interface BundleFile {
  readonly path: string;
  readonly text: string;
}

/** A whole project handed to the adapter as one source. */
export interface CodeProjectBundle {
  /** The ingest-root basename — the `code:project` node's name/source. */
  readonly root: string;
  readonly files: readonly BundleFile[];
}

/** Normalize to a repo-relative POSIX path: forward slashes, NFC, no `./`. */
export function normalizePosixPath(path: string): string {
  let p = path.normalize('NFC').replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  p = p.replace(/^\/+/, '');
  return p;
}

/** Deterministic bundle JSON: files sorted by normalized path. */
export function encodeProjectBundle(bundle: CodeProjectBundle): string {
  const files = [...bundle.files]
    .map((f) => ({ path: normalizePosixPath(f.path), text: f.text }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return JSON.stringify({ root: bundle.root, files });
}

/** Parse and shape-check a bundle; throws a located error on malformed input. */
export function decodeProjectBundle(text: string): CodeProjectBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`adapter-code: project bundle is not valid JSON: ${(e as Error).message}`);
  }
  const obj = raw as { root?: unknown; files?: unknown };
  if (typeof obj.root !== 'string' || obj.root.length === 0) {
    throw new Error('adapter-code: project bundle is missing a non-empty "root"');
  }
  if (!Array.isArray(obj.files)) {
    throw new Error('adapter-code: project bundle "files" must be an array');
  }
  const files: BundleFile[] = obj.files.map((f, i) => {
    const file = f as { path?: unknown; text?: unknown };
    if (typeof file.path !== 'string' || typeof file.text !== 'string') {
      throw new Error(`adapter-code: project bundle file ${i} must have string "path" and "text"`);
    }
    return { path: normalizePosixPath(file.path), text: file.text };
  });
  return { root: obj.root, files };
}
