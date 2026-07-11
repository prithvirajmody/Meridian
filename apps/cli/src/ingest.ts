/**
 * `meridian ingest` / `meridian plugins` — the CLI as composition root
 * (ARCHITECTURE.md §20): it wires graph-core's ID derivation into the plugin
 * host, registers the built-in (Tier 0) plugins, runs the host's arbitration
 * and isolation, and holds the IR gate — decode with the host's registered
 * vocabulary (U8) — between parser output and anything downstream.
 */
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { markdownPlugin } from '@meridian/adapter-markdown';
import {
  CODE_PROJECT_MEDIA_TYPE,
  createCodePlugin,
  createWorkerMapper,
  encodeProjectBundle,
  ParseWorkerHost,
  type BundleFile,
  type CodeMapper,
} from '@meridian/adapter-code';
import { codeWorkerFactory } from './code-worker.js';
import {
  decode,
  deriveEdgeId,
  deriveGraphId,
  deriveNodeId,
  createGraphSpace,
  encode,
  encodePretty,
  stats,
  type DocumentProducer,
  type GraphId,
  type GraphSpace,
  type Issue,
  type NodeId,
} from '@meridian/graph-core';
import { createStore, decodeDeltaInput } from '@meridian/graph-store';
import { PLUGIN_API_VERSION, type IdFacade, type SourceDescriptor } from '@meridian/plugin-api';
import { createPluginHost, type PluginHost } from '@meridian/plugin-host';

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  mdown: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
};

function out(line: string): void {
  process.stdout.write(line + '\n');
}

function formatIssue(issue: Issue): string {
  const location = issue.path !== undefined ? `at ${issue.path}: ` : '';
  return `[${issue.code}] ${location}${issue.message}`;
}

const idFacade: IdFacade = {
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
  const plugins = [markdownPlugin, createCodePlugin({ mapper })];
  for (const plugin of plugins) {
    const r = host.register(plugin);
    if (!r.ok) {
      // A built-in that cannot register is a build defect, not a user error.
      process.stderr.write(`built-in plugin failed to register: ${r.issue.message}\n`);
      process.exit(2);
    }
  }
  return { host, dispose: () => mapper.dispose() };
}

const TS_EXTENSIONS = /\.(tsx|mts|cts|ts)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.turbo']);

/** Walk a directory into a code-project bundle descriptor (composition root
 * resolves I/O; the adapter only sees text — ADR-0009). */
async function readCodeProject(dir: string): Promise<SourceDescriptor> {
  const files: BundleFile[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full);
      } else if (entry.isFile() && TS_EXTENSIONS.test(entry.name)) {
        const text = await readFile(full, 'utf8');
        files.push({ path: relative(dir, full).split(sep).join('/'), text });
      }
    }
  };
  await walk(dir);
  const root = dir.split(sep).filter((s) => s.length > 0).pop() ?? dir;
  return {
    uri: dir,
    mediaType: CODE_PROJECT_MEDIA_TYPE,
    text: encodeProjectBundle({ root, files }),
  };
}

async function readSource(path: string): Promise<SourceDescriptor> {
  try {
    if ((await stat(path)).isDirectory()) return await readCodeProject(path);
  } catch (e) {
    process.stderr.write(`cannot read ${path}: ${(e as Error).message}\n`);
    process.exit(2);
  }
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch (e) {
    process.stderr.write(`cannot read ${path}: ${(e as Error).message}\n`);
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

interface MaterializeResult {
  readonly space: GraphSpace;
  readonly producer: DocumentProducer;
}

export async function cmdIngest(
  sourcePath: string,
  opts: { json: boolean; adapter?: string; out?: string },
): Promise<number> {
  const built = buildHost();
  const { host } = built;
  try {
    return await runIngest(host, sourcePath, opts);
  } finally {
    await built.dispose();
  }
}

async function runIngest(
  host: PluginHost,
  sourcePath: string,
  opts: { json: boolean; adapter?: string; out?: string },
): Promise<number> {
  const src = await readSource(sourcePath);
  const outcome = await host.ingest(src, {
    ...(opts.adapter !== undefined ? { parser: opts.adapter } : {}),
  });

  if (!outcome.ok) {
    if (opts.json) {
      out(JSON.stringify({ source: sourcePath, ok: false, issue: outcome.issue }, null, 2));
    } else {
      out(`INGEST FAILED ${sourcePath}`);
      out(`  [${outcome.issue.code}] ${outcome.issue.message}`);
    }
    return 1;
  }

  // The IR gate (§6.4): everything a parser emits is decoded and validated
  // against the registered vocabulary before it counts as ingested.
  const vocabulary = host.vocabulary();
  const gated: MaterializeResult[] = [];
  for (const doc of outcome.documents) {
    const result = decode(doc, { vocabulary });
    if (!result.ok) {
      out(`GATE REJECTED ${sourcePath} — the "${outcome.domain}" parser emitted an invalid document (parser bug)`);
      for (const issue of result.errors) out(`    ${formatIssue(issue)}`);
      return 1;
    }
    gated.push({ space: result.space, producer: doc.producer });
  }

  let materialized: MaterializeResult;
  if (gated.length === 1 && outcome.deltas.length === 0) {
    materialized = gated[0]!;
  } else if (gated.length === 0 && outcome.deltas.length > 0) {
    // Delta-streaming parsers (contract v1, exercised fully in P7): replay
    // through a real store — the ops pass the same validation as any delta.
    const store = createStore(createGraphSpace());
    for (const [i, delta] of outcome.deltas.entries()) {
      const decoded = decodeDeltaInput(delta);
      if (!decoded.ok) {
        out(`GATE REJECTED ${sourcePath} — delta ${i} does not parse (parser bug)`);
        return 1;
      }
      const applied = store.apply(decoded.delta);
      if (!applied.ok) {
        out(`GATE REJECTED ${sourcePath} — delta ${i} rejected by the store (parser bug)`);
        return 1;
      }
    }
    const gate = decode(encode(store.snapshot()), { vocabulary });
    if (!gate.ok) {
      out(`GATE REJECTED ${sourcePath} — replayed deltas violate the registered vocabulary`);
      for (const issue of gate.errors) out(`    ${formatIssue(issue)}`);
      return 1;
    }
    const plugin = host.plugins().find((p) => p.manifest.name === outcome.plugin)!;
    materialized = {
      space: gate.space,
      producer: { name: plugin.manifest.name, version: plugin.manifest.version },
    };
  } else {
    out(`INGEST FAILED ${sourcePath}`);
    out(
      `  [unsupported-emission] the "${outcome.domain}" parser emitted ${outcome.documents.length} documents and ${outcome.deltas.length} deltas — this CLI materializes exactly one document, or a pure delta stream`,
    );
    return 1;
  }

  const { space, producer } = materialized;
  const s = stats(space);
  const written: string[] = [];
  if (opts.out !== undefined) {
    await writeFile(opts.out, encodePretty(space, { producer }), 'utf8');
    written.push(opts.out);
  }

  const report = outcome.report;
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
            provenance: report.provenance,
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
  out(`  provenance source ${report.provenance.source} · derived ${report.provenance.derived} · ai ${report.provenance.ai}`);
  if (report.warnings.length > 0) {
    out(`  warnings (${report.warnings.length}):`);
    for (const w of report.warnings) out(`    ${w}`);
  }
  for (const w of written) out(`  wrote ${w}`);
  return 0;
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
