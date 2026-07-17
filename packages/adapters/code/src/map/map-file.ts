/**
 * Map one project file to its {@link RawModule}, applying the ADR-0027 exclusion
 * policy. Shared by the full-ingest plugin ({@link ../plugin.js}) and the
 * incremental session ({@link ../incremental/session.js}) so a file is mapped
 * identically whether it arrives in a cold ingest or a watch-mode edit — the
 * "factor only where it repeats" rule (7D), now that it repeats.
 */
import type { BundleFile } from '../bundle.js';
import { normalizePosixPath } from '../bundle.js';
import { isCodeLanguage, languageForPath } from '../languages.js';
import type { CodeMapper } from '../mapper.js';
import type { RawModule } from './raw.js';

/** ADR-0027 oversize threshold: a file this large is flagged excluded and not
 * walked (contributes a cold, non-resolvable module node). */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_LOC = 50_000;

/** Any code extension this adapter routes (7D: TypeScript + Python). */
export const CODE_EXTENSIONS = /\.(tsx|mts|cts|ts|pyi|py)$/i;

export function oversizeReason(text: string): 'oversize' | undefined {
  if (text.length > MAX_FILE_BYTES) return 'oversize';
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return lines > MAX_FILE_LOC ? 'oversize' : undefined;
}

/**
 * Map one file to its module skeleton. Returns `undefined` for a file this
 * adapter does not route (not TypeScript/Python) — the caller skips it. An
 * oversize file contributes a flagged, cold, non-resolvable module (no walk).
 */
export async function mapFileToModule(
  mapper: Pick<CodeMapper, 'mapModule'>,
  file: BundleFile,
  opts: { readonly signal?: AbortSignal } = {},
): Promise<RawModule | undefined> {
  const language = languageForPath(file.path);
  if (language === undefined || !isCodeLanguage(language)) return undefined;
  const source = normalizePosixPath(file.path);
  const label = source.split('/').pop() ?? source;
  const excluded = oversizeReason(file.text);
  if (excluded !== undefined) {
    return {
      source,
      language,
      label,
      span: [0, file.text.length],
      decls: [],
      imports: [],
      hasErrors: false,
      errorCount: 0,
      excluded,
    };
  }
  return mapper.mapModule({ language, source, label, text: file.text }, opts);
}
