/**
 * `meridian watch <repo>` (Phase 7G): follow a source directory and turn each
 * file save into a **minimal** `GraphDelta` via the code adapter's
 * `IncrementalAdapter`, applied to a live store whose change events stream out —
 * the watch-mode analogue of `meridian ingest <repo>`. The CLI is the
 * composition root (§20): it owns the filesystem + worker wiring; the adapter
 * only ever sees text (ADR-0009).
 *
 * Two modes, mirroring `watch <file>`:
 * - default: **live** — `fs.watch` the tree, debounce, re-parse the touched file;
 * - `--edits <script.json>`: replay a recorded edit sequence and exit
 *   (deterministic, for tests and scripted demos). Each entry is
 *   `{ "path": "rel/f.ts", "newText": "…" }`, or `{ "path": "…", "delete": true }`.
 */
import { watch as fsWatch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import {
  codeManifest,
  createCodeIncrementalSession,
  languageForPath,
  type CodeIncrementalSession,
} from '@meridian/adapter-code';
import { decode, type VocabularyRegistry } from '@meridian/graph-core';
import {
  createStore,
  decodeDeltaInput,
  formatVersion,
  type ChangeSet,
  type GraphStore,
} from '@meridian/graph-store';
import type { IngestSink, SourceChange } from '@meridian/plugin-api';
import type { CodeLanguage } from '@meridian/adapter-code';
import { buildCodeMapper, idFacade, isCodeFile, readCodeFiles, type CodeWalkOptions } from './ingest.js';
import { buildPathFilter } from './globs.js';
import { stderrLine, stdoutLine } from './io.js';

function out(line: string): void {
  stdoutLine(line);
}

const codeVocabulary: VocabularyRegistry = {
  kinds: new Set(codeManifest.kinds ?? []),
  attrs: new Map(Object.entries(codeManifest.attrSchemas ?? {}).map(([k, v]) => [k, v.type])),
};

const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Run one change through the session and apply its delta to the store. Returns
 * the number of ops committed (0 = a no-op edit, e.g. whitespace). */
async function applyChange(
  session: CodeIncrementalSession,
  store: GraphStore,
  change: SourceChange,
): Promise<number> {
  const deltas: { ops: readonly unknown[] }[] = [];
  const sink: IngestSink = {
    emitDocument: () => undefined,
    emitDelta: (d) => deltas.push(d),
    progress: () => undefined,
  };
  await session.update(change, sink);
  let ops = 0;
  for (const d of deltas) {
    if (d.ops.length === 0) continue; // empty delta: nothing to commit (ADR-0028)
    const decoded = decodeDeltaInput(d);
    if (!decoded.ok) {
      stderrLine(`  delta did not decode (adapter bug): ${JSON.stringify(decoded.errors)}`);
      continue;
    }
    const applied = store.apply(decoded.delta); // fires the change subscription
    if (!applied.ok) {
      stderrLine(`  delta rejected by store: ${JSON.stringify(applied.errors)}`);
      continue;
    }
    ops += decoded.delta.ops.length;
  }
  return ops;
}

interface ScriptedEdit {
  readonly path: string;
  readonly newText?: string;
  readonly delete?: boolean;
}

export interface WatchRepoOptions {
  readonly json: boolean;
  readonly edits?: string;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly langs?: ReadonlySet<CodeLanguage>;
}

/** True for a repo-relative POSIX path the watcher routes under the active
 * include/exclude globs and language allowlist (mirrors the initial walk). */
function routedUnder(opts: WatchRepoOptions): (rel: string) => boolean {
  const filter = buildPathFilter({ include: opts.include, exclude: opts.exclude });
  const langs = opts.langs;
  return (rel: string): boolean => {
    if (!isCodeFile(rel)) return false;
    const language = languageForPath(rel);
    if (langs !== undefined && (language === undefined || !langs.has(language))) return false;
    return filter.accepts(rel);
  };
}

/**
 * `cmdWatchRepo`. `printChange` is injected (the CLI owns change-event
 * formatting) so this module carries no presentation of its own.
 */
export async function cmdWatchRepo(
  dir: string,
  opts: WatchRepoOptions,
  printChange: (change: ChangeSet) => void,
): Promise<number> {
  const walk: CodeWalkOptions = {
    ...(opts.include !== undefined ? { include: opts.include } : {}),
    ...(opts.exclude !== undefined ? { exclude: opts.exclude } : {}),
    ...(opts.langs !== undefined ? { langs: opts.langs } : {}),
  };
  const { root, files } = await readCodeFiles(dir, walk);
  const { mapper, dispose } = buildCodeMapper();
  try {
    const session = await createCodeIncrementalSession({ mapper, ids: idFacade }, { root, files });
    const gate = decode(session.document(), { vocabulary: codeVocabulary });
    if (!gate.ok) {
      out(`INVALID initial ingest of ${dir} (${gate.errors.length} errors)`);
      return 1;
    }
    const store = createStore(gate.space, {
      onListenerError: (e) => stderrLine(`listener error: ${String(e)}`),
    });
    store.subscribe(printChange);
    const banner = `watching ${dir} — ${formatVersion(store.version())} · ${files.length} file${files.length === 1 ? '' : 's'} · ${gate.space.graphs.size} graphs`;

    if (opts.edits !== undefined) {
      out(banner);
      return await replayEdits(session, store, dir, opts.edits);
    }
    await liveWatch(session, store, dir, routedUnder(opts), () => out(banner));
    return 0;
  } finally {
    await dispose();
  }
}

/** Scripted replay: apply each recorded edit in order, then exit. */
async function replayEdits(
  session: CodeIncrementalSession,
  store: GraphStore,
  dir: string,
  scriptPath: string,
): Promise<number> {
  let script: ScriptedEdit[];
  try {
    script = JSON.parse(await readFile(scriptPath, 'utf8')) as ScriptedEdit[];
  } catch (e) {
    stderrLine(`cannot read edits ${scriptPath}: ${(e as Error).message}`);
    return 2;
  }
  let empties = 0;
  for (const edit of script) {
    const change: SourceChange =
      edit.delete === true || edit.newText === undefined
        ? { path: edit.path }
        : { path: edit.path, newText: edit.newText };
    const ops = await applyChange(session, store, change);
    await flushMicrotasks(); // keep each edit's change event ahead of the next
    if (ops === 0) {
      out(`  ${edit.path}: no semantic change (empty delta)`);
      empties++;
    }
  }
  await flushMicrotasks();
  out(`done: ${formatVersion(store.version())} · ${script.length} edit${script.length === 1 ? '' : 's'} (${empties} no-op)`);
  return 0;
}

/**
 * Live mode: follow the tree; each save is re-parsed into a minimal delta.
 * `onReady` announces the session only after the watcher is armed, so a save
 * made as soon as the banner appears is never missed.
 */
async function liveWatch(
  session: CodeIncrementalSession,
  store: GraphStore,
  dir: string,
  routed: (rel: string) => boolean,
  onReady: () => void,
): Promise<void> {
  const pending = new Map<string, NodeJS.Timeout>();
  const onEvent = (filename: string | null): void => {
    if (filename === null) return;
    const rel = filename.split(sep).join('/');
    if (!routed(rel)) return;
    const prior = pending.get(rel);
    if (prior) clearTimeout(prior);
    pending.set(
      rel,
      setTimeout(() => {
        pending.delete(rel);
        void onFileChange(session, store, dir, rel);
      }, 60),
    );
  };
  fsWatch(dir, { recursive: true }, (_event, filename) => onEvent(filename ? String(filename) : null));
  onReady();
  await new Promise<void>((resolve) => process.once('SIGINT', () => resolve()));
}

async function onFileChange(
  session: CodeIncrementalSession,
  store: GraphStore,
  dir: string,
  rel: string,
): Promise<void> {
  let newText: string | undefined;
  try {
    newText = await readFile(join(dir, rel), 'utf8');
  } catch {
    newText = undefined; // vanished → deletion
  }
  const change: SourceChange = newText === undefined ? { path: rel } : { path: rel, newText };
  const ops = await applyChange(session, store, change);
  if (ops === 0) out(`${rel}: changed — no semantic difference`);
}
