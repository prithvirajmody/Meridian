/**
 * Corpus loading for conformance runs. The kit itself is I/O-free; this
 * helper is the one place it touches the filesystem, because adapter corpora
 * live under `fixtures/corpora/<domain>/` and every adapter test would
 * otherwise re-write the same directory walk. Files under a `reject/`
 * subdirectory are expected to fail ingest (crash containment).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { SourceDescriptor } from '@meridian/plugin-api';

export interface CorpusEntry {
  readonly name: string;
  readonly source: SourceDescriptor;
  /**
   * 'ok' (default): the parser must claim, ingest, and gate-cleanly emit.
   * 'reject': the parser must fail this input with an error — and remain
   * fully usable afterwards (crash containment, §7.4).
   */
  readonly expect?: 'ok' | 'reject';
}

export interface LoadCorpusOptions {
  /** Media types by lowercase extension (without dot). The kit ships no
   * defaults — file-type knowledge is the adapter's, never the contract's. */
  readonly mediaTypes?: Readonly<Record<string, string>>;
  /** URI prefix for the descriptors; defaults to the corpus-relative path. */
  readonly uriBase?: string;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out.sort();
}

/** Deterministic corpus load: sorted walk, binary detection by NUL byte. */
export function loadCorpusDir(dir: string, opts: LoadCorpusOptions = {}): CorpusEntry[] {
  const mediaTypes = opts.mediaTypes ?? {};
  return listFiles(dir).map((file) => {
    const rel = relative(dir, file).split(sep).join('/');
    const bytes = readFileSync(file);
    const ext = file.includes('.') ? file.slice(file.lastIndexOf('.') + 1).toLowerCase() : '';
    const mediaType = mediaTypes[ext];
    const uri = (opts.uriBase ?? '') + rel;
    const isBinary = bytes.includes(0);
    const source: SourceDescriptor = {
      uri,
      ...(mediaType !== undefined ? { mediaType } : {}),
      ...(isBinary
        ? { bytes: new Uint8Array(bytes) }
        : { text: bytes.toString('utf8') }),
    };
    return {
      name: rel,
      source,
      expect: rel.split('/').includes('reject') ? ('reject' as const) : ('ok' as const),
    };
  });
}
