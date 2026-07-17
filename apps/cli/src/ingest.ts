/**
 * `meridian ingest` / `meridian plugins` — the CLI as composition root
 * (ARCHITECTURE.md §20): it wires graph-core's ID derivation into the plugin
 * host, registers the built-in (Tier 0) plugins, runs the host's arbitration
 * and isolation, and holds the IR gate — decode with the host's registered
 * vocabulary (U8) — between parser output and anything downstream.
 */
import { readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { argumentPlugin } from '@meridian/adapter-argument';
import { conversationPlugin } from '@meridian/adapter-conversation';
import { markdownPlugin } from '@meridian/adapter-markdown';
import {
  CODE_PROJECT_MEDIA_TYPE,
  createCodePlugin,
  createWorkerMapper,
  encodeProjectBundle,
  languageForPath,
  ParseWorkerHost,
  type BundleFile,
  type CodeLanguage,
  type CodeMapper,
} from '@meridian/adapter-code';
import { buildPathFilter } from './globs.js';
import { codeWorkerFactory } from './code-worker.js';
import { stderrLine, stdoutLine, writeStderr } from './io.js';
import {
  deriveEdgeId,
  deriveGraphId,
  deriveNodeId,
  encodePretty,
  stats,
  type GraphId,
  type GraphSpace,
  type NodeId,
} from '@meridian/graph-core';
import { PLUGIN_API_VERSION, type IdFacade, type SourceDescriptor } from '@meridian/plugin-api';
import { createPluginHost, type PluginHost } from '@meridian/plugin-host';
import { materializeStreamedSource } from './stream-ingest.js';

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  mdown: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
};

function out(line: string): void {
  stdoutLine(line);
}

export const idFacade: IdFacade = {
  nodeId: (coords) => deriveNodeId(coords) as string,
  graphId: (coords) => deriveGraphId(coords) as string,
  edgeId: (coords) =>
    deriveEdgeId({
      graph: coords.graph as GraphId,
      kind: coords.kind,
      src: coords.src as NodeId,
      dst: coords.dst as NodeId,
      ...(coords.occurrence !== undefined ? { occurrence: coords.occurrence } : {}),
    }) as string,
};

/** A host wired with the Tier-0 plugins, plus a handle to release the code
 * adapter's parse worker (ADR-0009: statically imported built-ins). */
export interface BuiltHost {
  readonly host: PluginHost;
  dispose(): Promise<void>;
}

export function buildHost(): BuiltHost {
  const host = createPluginHost({ ids: idFacade });
  // The code adapter parses in a worker (grammars only in workers, ADR-0017);
  // the worker is lazy, so `plugins list` never spawns one.
  const parseHost = new ParseWorkerHost({ factory: codeWorkerFactory() });
  const mapper: CodeMapper = createWorkerMapper(parseHost);
  const plugins = [markdownPlugin, createCodePlugin({ mapper }), conversationPlugin, argumentPlugin];
  for (const plugin of plugins) {
    const r = host.register(plugin);
    if (!r.ok) {
      // A built-in that cannot register is a build defect, not a user error.
      stderrLine(`built-in plugin failed to register: ${r.issue.message}`);
      process.exit(2);
    }
  }
  return { host, dispose: () => mapper.dispose() };
}

const CODE_EXTENSIONS = /\.(tsx|mts|cts|ts|pyi|py)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.turbo']);

/** True for a code file this adapter routes (the watcher uses it to filter). */
export function isCodeFile(name: string): boolean {
  return CODE_EXTENSIONS.test(name);
}

/**
 * Adapter walk options (ROADMAP Phase 7 §6). The CLI owns the filesystem
 * (ADR-0009), so include/exclude globs and the language allowlist filter the
 * walk here — an excluded or non-allowed file is never read, and so never
 * enters the graph (clean semantics; see the phase-07 checklist note vs
 * ADR-0027's `code:excluded` ghost-node reading, which is reserved for the
 * in-tree-but-unparseable oversize/generated cases).
 */
export interface CodeWalkOptions {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly langs?: ReadonlySet<CodeLanguage>;
}

/** Walk a directory into the project name + repo-relative code files
 * (composition root resolves I/O; the adapter only sees text — ADR-0009).
 * Symlinks are not followed and a realpath visited-set guards against cycles,
 * so a symlink loop at the root neither hangs nor duplicates content. */
export async function readCodeFiles(
  dir: string,
  opts: CodeWalkOptions = {},
): Promise<{ root: string; files: BundleFile[] }> {
  const files: BundleFile[] = [];
  const filter = buildPathFilter({ include: opts.include, exclude: opts.exclude });
  const langs = opts.langs;
  const visited = new Set<string>(); // realpaths already walked — the cycle guard
  const walk = async (current: string): Promise<void> => {
    let real: string;
    try {
      real = await realpath(current);
    } catch {
      return; // dangling symlink target or vanished directory
    }
    if (visited.has(real)) return; // a cycle would re-enter here: stop (no hang, no dup)
    visited.add(real);
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue; // the composition root does not follow symlinks
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full);
      } else if (entry.isFile() && CODE_EXTENSIONS.test(entry.name)) {
        const rel = relative(dir, full).split(sep).join('/');
        const language = languageForPath(rel);
        if (langs !== undefined && (language === undefined || !langs.has(language))) continue;
        if (!filter.accepts(rel)) continue;
        const text = await readFile(full, 'utf8');
        files.push({ path: rel, text });
      }
    }
  };
  await walk(dir);
  const root = dir.split(sep).filter((s) => s.length > 0).pop() ?? dir;
  return { root, files };
}

/** A worker-backed code mapper (grammars only in workers, ADR-0017) plus its
 * release handle — the pieces `meridian watch <repo>` wires into a session. */
export function buildCodeMapper(): { mapper: CodeMapper; dispose: () => Promise<void> } {
  const parseHost = new ParseWorkerHost({ factory: codeWorkerFactory() });
  const mapper = createWorkerMapper(parseHost);
  return { mapper, dispose: () => mapper.dispose() };
}

async function readCodeProject(dir: string, walk: CodeWalkOptions): Promise<SourceDescriptor> {
  const { root, files } = await readCodeFiles(dir, walk);
  return {
    uri: dir,
    mediaType: CODE_PROJECT_MEDIA_TYPE,
    text: encodeProjectBundle({ root, files }),
  };
}

async function readSource(path: string, walk: CodeWalkOptions): Promise<SourceDescriptor> {
  try {
    if ((await stat(path)).isDirectory()) return await readCodeProject(path, walk);
  } catch (e) {
    stderrLine(`cannot read ${path}: ${(e as Error).message}`);
    process.exit(2);
  }
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch (e) {
    stderrLine(`cannot read ${path}: ${(e as Error).message}`);
    process.exit(2);
  }
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
  const mediaType = MEDIA_TYPES[ext];
  const isBinary = raw.includes(0);
  return {
    uri: path,
    ...(mediaType !== undefined ? { mediaType } : {}),
    ...(isBinary ? { bytes: new Uint8Array(raw) } : { text: raw.toString('utf8') }),
  };
}

export interface IngestOptions {
  readonly json: boolean;
  readonly adapter?: string;
  readonly out?: string;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly langs?: ReadonlySet<CodeLanguage>;
}

export async function cmdIngest(sourcePath: string, opts: IngestOptions): Promise<number> {
  const built = buildHost();
  const { host } = built;
  try {
    return await runIngest(host, sourcePath, opts);
  } finally {
    await built.dispose();
  }
}

async function runIngest(host: PluginHost, sourcePath: string, opts: IngestOptions): Promise<number> {
  const walk: CodeWalkOptions = {
    ...(opts.include !== undefined ? { include: opts.include } : {}),
    ...(opts.exclude !== undefined ? { exclude: opts.exclude } : {}),
    ...(opts.langs !== undefined ? { langs: opts.langs } : {}),
  };
  const src = await readSource(sourcePath, walk);
  const progress = new TerminalIngestProgress(!opts.json && process.stderr.isTTY === true);
  const streamed = await materializeStreamedSource(host, src, {
    ...(opts.adapter !== undefined ? { parser: opts.adapter } : {}),
    maxOpsPerBatch: 512,
    onParserProgress: (event) => progress.parser(event.stage, event.done, event.total),
    onStageProgress: (event) => progress.stage(event.appliedOps, event.batches),
  });
  progress.finish();

  if (!streamed.ok) return reportStreamFailure(sourcePath, opts.json, streamed);

  const { outcome, materialized } = streamed;

  const { space, producer } = materialized;
  const s = stats(space);
  const written: string[] = [];
  if (opts.out !== undefined) {
    try {
      await writeFile(opts.out, encodePretty(space, { producer }), 'utf8');
    } catch (cause) {
      const message = `cannot write ${opts.out}: ${cause instanceof Error ? cause.message : String(cause)}`;
      if (opts.json) {
        out(JSON.stringify({ source: sourcePath, ok: false, issue: { code: 'storage-io', message } }, null, 2));
      } else {
        out(`INGEST FAILED ${sourcePath}`);
        out(`  [storage-io] ${message}`);
      }
      return 1;
    }
    written.push(opts.out);
  }

  const report = outcome.report;
  const provenance = tallyProvenance(space);
  if (opts.json) {
    out(
      JSON.stringify(
        {
          source: sourcePath,
          ok: true,
          adapter: outcome.domain,
          plugin: outcome.plugin,
          report: {
            documents: report.documents,
            deltas: report.deltas,
            provenance,
            warnings: report.warnings,
          },
          stats: s,
          written,
          document: JSON.parse(encodePretty(space, { producer })),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  out(`INGESTED ${sourcePath}`);
  out(`  adapter    ${outcome.domain} (${outcome.plugin})`);
  out(`  emitted    ${report.documents} document${report.documents === 1 ? '' : 's'} · ${report.deltas} delta${report.deltas === 1 ? '' : 's'}`);
  out(`  graphs ${s.graphs} · nodes ${s.nodes} · edges ${s.edges} · roots ${s.roots} · max depth ${s.maxDepth}`);
  out(`  provenance source ${provenance.source} · derived ${provenance.derived} · ai ${provenance.ai}`);
  if (report.warnings.length > 0) {
    out(`  warnings (${report.warnings.length}):`);
    for (const w of report.warnings) out(`    ${w}`);
  }
  for (const w of written) out(`  wrote ${w}`);
  return 0;
}

class TerminalIngestProgress {
  private visible = false;

  constructor(private readonly enabled: boolean) {}

  parser(stage: string, done: number, total?: number): void {
    const suffix = total === undefined ? `${done}` : `${done}/${total}`;
    this.render(`ingest ${stage} ${suffix}`);
  }

  stage(appliedOps: number, batches: number): void {
    this.render(`ingest apply ${appliedOps} ops · ${batches} batches`);
  }

  finish(): void {
    if (!this.enabled || !this.visible) return;
    writeStderr('\r\x1b[2K');
    this.visible = false;
  }

  private render(message: string): void {
    if (!this.enabled) return;
    writeStderr(`\r\x1b[2K${message}`);
    this.visible = true;
  }
}

function tallyProvenance(space: GraphSpace): { source: number; derived: number; ai: number } {
  const tally = { source: 0, derived: 0, ai: 0 };
  const add = (origin: 'source' | 'derived' | 'ai'): void => {
    tally[origin] += 1;
  };
  for (const graph of space.graphs.values()) {
    add(graph.meta.provenance.origin);
    for (const node of graph.nodes.values()) add(node.provenance.origin);
    for (const edge of graph.edges.values()) add(edge.provenance.origin);
  }
  return tally;
}

function reportStreamFailure(
  sourcePath: string,
  json: boolean,
  failure: Extract<Awaited<ReturnType<typeof materializeStreamedSource>>, { readonly ok: false }>,
): number {
  if (failure.reason === 'host' && !failure.outcome.ok) {
    if (json) out(JSON.stringify({ source: sourcePath, ok: false, issue: failure.outcome.issue }, null, 2));
    else {
      out(`INGEST FAILED ${sourcePath}`);
      out(`  [${failure.outcome.issue.code}] ${failure.outcome.issue.message}`);
    }
    return 1;
  }

  const selectedReport = 'report' in failure.outcome ? failure.outcome.report : undefined;
  const domain = selectedReport?.domain ?? 'selected';
  if (failure.reason === 'document-gate') {
    out(`GATE REJECTED ${sourcePath} — the "${domain}" parser emitted an invalid document (parser bug)`);
  } else if (failure.reason === 'delta-gate') {
    out(`GATE REJECTED ${sourcePath} — delta ${failure.deltaIndex ?? 0} does not parse (parser bug)`);
  } else if (failure.reason === 'final-gate') {
    out(`GATE REJECTED ${sourcePath} — replayed deltas violate the registered vocabulary`);
  } else if (failure.reason === 'stage' && failure.stageFailure?.code === 'apply-failed') {
    out(`GATE REJECTED ${sourcePath} — delta ${failure.stageFailure.emissionIndex ?? 0} rejected by the store (parser bug)`);
  } else if (failure.reason === 'unsupported-emission') {
    const report = selectedReport;
    out(`INGEST FAILED ${sourcePath}`);
    out(
      `  [unsupported-emission] the "${domain}" parser emitted ${report?.documents ?? 0} documents and ${report?.deltas ?? 0} deltas — this CLI materializes exactly one document, or a pure delta stream`,
    );
    return 1;
  } else {
    const code = failure.stageFailure?.code ?? 'ingest-failed';
    if (json) out(JSON.stringify({ source: sourcePath, ok: false, issue: { code, message: failure.message } }, null, 2));
    else {
      out(`INGEST FAILED ${sourcePath}`);
      out(`  [${code}] ${failure.message}`);
    }
    return 1;
  }
  for (const issue of failure.issues ?? []) out(`    [${issue.code}] ${issue.message}`);
  return 1;
}

export function cmdPlugins(json: boolean): number {
  const { host, dispose } = buildHost();
  const plugins = host.plugins();
  void dispose(); // no worker was spawned (lazy); release any handle
  if (json) {
    out(JSON.stringify({ apiVersion: PLUGIN_API_VERSION, plugins: plugins.map((p) => p.manifest) }, null, 2));
    return 0;
  }
  out(`plugins (${plugins.length}):`);
  for (const p of plugins) {
    const m = p.manifest;
    out(`  ${m.name} ${m.version} — plugin-api ${m.apiVersion}`);
    out(`    capabilities  ${m.capabilities.map((c) => `${c.kind}:${c.id}`).join(', ')}`);
    if (m.kinds !== undefined && m.kinds.length > 0) {
      out(`    kinds         ${[...m.kinds].sort().join(', ')}`);
    }
    const attrs = Object.keys(m.attrSchemas ?? {}).sort();
    if (attrs.length > 0) out(`    attrs         ${attrs.join(', ')}`);
  }
  return 0;
}
