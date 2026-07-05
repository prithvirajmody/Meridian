/**
 * `meridian ingest` / `meridian plugins` — the CLI as composition root
 * (ARCHITECTURE.md §20): it wires graph-core's ID derivation into the plugin
 * host, registers the built-in (Tier 0) plugins, runs the host's arbitration
 * and isolation, and holds the IR gate — decode with the host's registered
 * vocabulary (U8) — between parser output and anything downstream.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { markdownPlugin } from '@meridian/adapter-markdown';
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

/** Built-in (Tier 0) plugins, statically imported per ADR-0009. */
const BUILTIN_PLUGINS = [markdownPlugin];

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

export function buildHost(): PluginHost {
  const host = createPluginHost({ ids: idFacade });
  for (const plugin of BUILTIN_PLUGINS) {
    const r = host.register(plugin);
    if (!r.ok) {
      // A built-in that cannot register is a build defect, not a user error.
      process.stderr.write(`built-in plugin failed to register: ${r.issue.message}\n`);
      process.exit(2);
    }
  }
  return host;
}

async function readSource(path: string): Promise<SourceDescriptor> {
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
  const host = buildHost();
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
  const host = buildHost();
  const plugins = host.plugins();
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
