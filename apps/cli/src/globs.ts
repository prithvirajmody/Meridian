/**
 * Minimal, dependency-free glob matching for `meridian ingest`/`watch` adapter
 * options (ROADMAP Phase 7 §6: include/exclude globs). The CLI is the
 * composition root that owns the filesystem walk (ADR-0009), so path filtering
 * lives here, not in the adapter. Globs match a file's repo-relative POSIX
 * path (`packages/adapters/code/src/scan.ts`).
 *
 * Supported syntax (the common subset — no brace/`extglob` expansion):
 * - `**` matches any run of characters including slashes (any number of
 *   segments); when directly followed by a slash it matches zero-or-more
 *   leading directories (so `packages` + slash-star-star covers `packages/x`).
 * - `*`  matches any run of characters except `/` (one segment).
 * - `?`  matches exactly one character except `/`.
 * - everything else is literal.
 */

/** Compile one glob to an anchored RegExp over a POSIX path. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?'; // `**/` — optional leading directories
        } else {
          re += '.*'; // `**` — any characters, crossing `/`
        }
      } else {
        re += '[^/]*'; // `*` — one segment
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c; // escape a regex metacharacter
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

/** A compiled include/exclude filter over repo-relative POSIX paths. */
export interface PathFilter {
  /** True iff the path passes the include (if any) and no exclude globs. */
  accepts(posixPath: string): boolean;
}

/**
 * Build a filter from raw include/exclude glob lists. Semantics: a path is
 * accepted iff it matches at least one include glob (or there are no includes)
 * **and** matches no exclude glob (exclude wins over include).
 */
export function buildPathFilter(opts: {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}): PathFilter {
  const include = (opts.include ?? []).map(globToRegExp);
  const exclude = (opts.exclude ?? []).map(globToRegExp);
  return {
    accepts(posixPath: string): boolean {
      if (exclude.some((r) => r.test(posixPath))) return false;
      if (include.length > 0 && !include.some((r) => r.test(posixPath))) return false;
      return true;
    },
  };
}

/** Parse a comma-separated CLI flag value into trimmed, non-empty tokens. */
export function splitCsv(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
