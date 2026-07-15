/**
 * The plugin host (roadmap Phase 2 §9 cap): it registers, validates,
 * resolves, and isolates errors — nothing else. It never touches a store,
 * never gates IR (the composition root does, with the vocabulary this host
 * aggregates), and never lets a plugin crash it (ADR-0009).
 */
import {
  PLUGIN_API_VERSION,
  type AttrSchema,
  type DeltaWire,
  type DomainParser,
  type GraphDocument,
  type IngestReport,
  type MeridianPlugin,
  type PluginContext,
  type PluginLogger,
  type PluginManifest,
  type Progress,
  type SourceDescriptor,
  type ViewProjectionExport,
} from '@meridian/plugin-api';
import { parseManifest } from './manifest.js';
import { satisfies } from './semver.js';
import type { HostIssue } from './issues.js';

export interface RegisteredPlugin {
  readonly manifest: PluginManifest;
  readonly parsers: readonly DomainParser[];
  readonly viewProjections: readonly ViewProjectionExport[];
}

/** One plugin's exported projection, in deterministic resolution order. */
export interface ViewProjectionRegistration {
  readonly plugin: string;
  readonly projection: ViewProjectionExport;
}

export type RegisterResult =
  | { readonly ok: true; readonly plugin: RegisteredPlugin }
  | { readonly ok: false; readonly issue: HostIssue };

/** One parser's claim on a source, after arbitration-safe clamping. */
export interface ParserCandidate {
  readonly plugin: string;
  readonly parser: DomainParser;
  readonly score: number;
}

export interface Resolution {
  /** Positive-score claimants, best first (score desc, then domain, then plugin). */
  readonly candidates: readonly ParserCandidate[];
  readonly warnings: readonly string[];
}

/** The union of every registered plugin's declared vocabulary (U8), shaped
 * for graph-core's `VocabularyRegistry` without this package importing it. */
export interface HostVocabulary {
  readonly attrs: ReadonlyMap<string, AttrSchema['type']>;
  readonly kinds: ReadonlySet<string>;
}

export interface IngestOptions {
  /** Force a parser by domain, bypassing sniff arbitration. */
  readonly parser?: string;
  readonly onProgress?: (p: Progress) => void;
}

export type IngestOutcome =
  | {
      readonly ok: true;
      readonly plugin: string;
      readonly domain: string;
      readonly documents: readonly GraphDocument[];
      readonly deltas: readonly DeltaWire[];
      readonly report: IngestReport;
    }
  | { readonly ok: false; readonly issue: HostIssue };

export interface HostOptions {
  /** Deterministic ID derivation for plugin contexts; the composition root
   * injects graph-core's implementation (the host may not import it, §20). */
  readonly ids: PluginContext['ids'];
  readonly log?: PluginLogger;
}

const SILENT: PluginLogger = { info: () => undefined, warn: () => undefined };

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class PluginHost {
  readonly #plugins = new Map<string, RegisteredPlugin>();
  readonly #attrs = new Map<string, AttrSchema['type']>();
  readonly #attrOwner = new Map<string, string>();
  readonly #kinds = new Set<string>();
  readonly #projectionOwner = new Map<string, string>();
  readonly #ctx: PluginContext;
  readonly #log: PluginLogger;

  constructor(opts: HostOptions) {
    this.#log = opts.log ?? SILENT;
    this.#ctx = { apiVersion: PLUGIN_API_VERSION, ids: opts.ids, log: this.#log };
  }

  /**
   * Discover → validate → resolve → activate → contribute (§14.3). Failure at
   * any stage isolates: the plugin is not registered, the host is unaffected.
   */
  register(plugin: MeridianPlugin): RegisterResult {
    const parsed = parseManifest(plugin.manifest);
    if (!parsed.ok) {
      return this.#refuse({
        code: 'invalid-manifest',
        message: `manifest rejected: ${parsed.errors.join('; ')}`,
        ...(typeof (plugin.manifest as { name?: unknown })?.name === 'string'
          ? { plugin: (plugin.manifest as { name: string }).name }
          : {}),
      });
    }
    const manifest = parsed.manifest;
    if (this.#plugins.has(manifest.name)) {
      return this.#refuse({
        code: 'duplicate-plugin',
        message: `plugin "${manifest.name}" is already registered`,
        plugin: manifest.name,
      });
    }
    if (!satisfies(PLUGIN_API_VERSION, manifest.apiVersion)) {
      return this.#refuse({
        code: 'api-version-incompatible',
        message: `plugin "${manifest.name}" requires plugin-api ${manifest.apiVersion}, host runs ${PLUGIN_API_VERSION} (ADR-0010)`,
        plugin: manifest.name,
      });
    }

    // Vocabulary conflicts are checked before activation — a plugin that
    // cannot contribute must not run code.
    for (const [key, schema] of Object.entries(manifest.attrSchemas ?? {})) {
      const prior = this.#attrs.get(key);
      if (prior !== undefined && prior !== schema.type) {
        return this.#refuse({
          code: 'vocabulary-conflict',
          message: `attr key "${key}" is already registered as ${prior} (by ${this.#attrOwner.get(key)}), plugin "${manifest.name}" declares ${schema.type}`,
          plugin: manifest.name,
        });
      }
    }

    let exports;
    try {
      exports = plugin.activate(this.#ctx);
    } catch (e) {
      return this.#refuse({
        code: 'activation-failed',
        message: `plugin "${manifest.name}" threw during activate: ${message(e)}`,
        plugin: manifest.name,
      });
    }

    const declaredDomains = manifest.capabilities
      .filter((c) => c.kind === 'domain-parser')
      .map((c) => c.id);
    const parsers = exports?.parsers ?? [];
    const exportedDomains = parsers.map((p) => p.domain);
    const missing = declaredDomains.filter((d) => !exportedDomains.includes(d));
    const undeclared = exportedDomains.filter((d) => !declaredDomains.includes(d));
    if (missing.length > 0 || undeclared.length > 0) {
      return this.#refuse({
        code: 'exports-mismatch',
        message:
          `plugin "${manifest.name}" exports must match declared domain-parser capabilities` +
          (missing.length > 0 ? `; declared but not exported: ${missing.join(', ')}` : '') +
          (undeclared.length > 0 ? `; exported but not declared: ${undeclared.join(', ')}` : ''),
        plugin: manifest.name,
      });
    }

    // The view-projection capability mirrors the parser discipline (ADR-0037):
    // declared ids and exported ids must agree, and an id is host-unique.
    const declaredProjections = manifest.capabilities
      .filter((c) => c.kind === 'view-projection')
      .map((c) => c.id);
    const viewProjections = exports?.viewProjections ?? [];
    const exportedProjections = viewProjections.map((p) => p.id);
    const missingProjections = declaredProjections.filter(
      (id) => !exportedProjections.includes(id),
    );
    const undeclaredProjections = exportedProjections.filter(
      (id) => !declaredProjections.includes(id),
    );
    if (missingProjections.length > 0 || undeclaredProjections.length > 0) {
      return this.#refuse({
        code: 'exports-mismatch',
        message:
          `plugin "${manifest.name}" exports must match declared view-projection capabilities` +
          (missingProjections.length > 0
            ? `; declared but not exported: ${missingProjections.join(', ')}`
            : '') +
          (undeclaredProjections.length > 0
            ? `; exported but not declared: ${undeclaredProjections.join(', ')}`
            : ''),
        plugin: manifest.name,
      });
    }
    for (const id of exportedProjections) {
      const owner = this.#projectionOwner.get(id);
      if (owner !== undefined) {
        return this.#refuse({
          code: 'capability-conflict',
          message: `view-projection id "${id}" is already registered by ${owner}`,
          plugin: manifest.name,
        });
      }
    }

    for (const [key, schema] of Object.entries(manifest.attrSchemas ?? {})) {
      if (!this.#attrs.has(key)) {
        this.#attrs.set(key, schema.type);
        this.#attrOwner.set(key, manifest.name);
      }
    }
    for (const kind of manifest.kinds ?? []) this.#kinds.add(kind);
    for (const id of exportedProjections) this.#projectionOwner.set(id, manifest.name);

    const registered: RegisteredPlugin = { manifest, parsers, viewProjections };
    this.#plugins.set(manifest.name, registered);
    this.#log.info(`registered ${manifest.name}@${manifest.version}`);
    return { ok: true, plugin: registered };
  }

  plugins(): readonly RegisteredPlugin[] {
    return [...this.#plugins.values()];
  }

  /** Every exported view projection in deterministic order: registration
   * order per plugin, export order within a plugin (ADR-0037). */
  viewProjections(): readonly ViewProjectionRegistration[] {
    const ordered: ViewProjectionRegistration[] = [];
    for (const plugin of this.#plugins.values()) {
      for (const projection of plugin.viewProjections) {
        ordered.push({ plugin: plugin.manifest.name, projection });
      }
    }
    return ordered;
  }

  vocabulary(): HostVocabulary {
    return { attrs: this.#attrs, kinds: this.#kinds };
  }

  /** Sniff arbitration (§7.2.2). A throwing or out-of-range sniff never
   * disqualifies the source — it disqualifies the claim, with a warning. */
  resolve(src: SourceDescriptor): Resolution {
    const candidates: ParserCandidate[] = [];
    const warnings: string[] = [];
    for (const plugin of this.#plugins.values()) {
      for (const parser of plugin.parsers) {
        let score: number;
        try {
          score = parser.sniff(src);
        } catch (e) {
          warnings.push(
            `sniff by "${parser.domain}" (${plugin.manifest.name}) threw and was scored 0: ${message(e)}`,
          );
          continue;
        }
        if (!Number.isFinite(score)) {
          warnings.push(
            `sniff by "${parser.domain}" (${plugin.manifest.name}) returned ${String(score)} and was scored 0`,
          );
          continue;
        }
        const clamped = Math.max(0, Math.min(1, score));
        if (clamped > 0) {
          candidates.push({ plugin: plugin.manifest.name, parser, score: clamped });
        }
      }
    }
    candidates.sort(
      (a, b) =>
        b.score - a.score ||
        a.parser.domain.localeCompare(b.parser.domain) ||
        a.plugin.localeCompare(b.plugin),
    );
    return { candidates, warnings };
  }

  /**
   * Run one parser over one source with buffered, atomic emission: if the
   * parser throws mid-stream, everything it emitted is discarded and the
   * failure is a typed issue — the host and its plugins remain usable.
   */
  async ingest(src: SourceDescriptor, opts: IngestOptions = {}): Promise<IngestOutcome> {
    const warnings: string[] = [];
    let chosen: { plugin: string; parser: DomainParser } | undefined;

    if (opts.parser !== undefined) {
      const matches = [...this.#plugins.values()].flatMap((pl) =>
        pl.parsers
          .filter((p) => p.domain === opts.parser)
          .map((p) => ({ plugin: pl.manifest.name, parser: p })),
      );
      if (matches.length === 0) {
        return {
          ok: false,
          issue: {
            code: 'unknown-parser',
            message: `no registered parser has domain "${opts.parser}"`,
          },
        };
      }
      if (matches.length > 1) {
        return {
          ok: false,
          issue: {
            code: 'ambiguous-source',
            message: `domain "${opts.parser}" is provided by more than one plugin: ${matches.map((m) => m.plugin).join(', ')}`,
          },
        };
      }
      chosen = matches[0]!;
    } else {
      const { candidates, warnings: sniffWarnings } = this.resolve(src);
      warnings.push(...sniffWarnings);
      const [best, second] = candidates;
      if (best === undefined) {
        return {
          ok: false,
          issue: {
            code: 'no-parser',
            message: `no registered parser claims "${src.uri}" (${candidates.length} claimants)`,
          },
        };
      }
      if (second !== undefined && second.score === best.score) {
        return {
          ok: false,
          issue: {
            code: 'ambiguous-source',
            message:
              `"${src.uri}" is claimed equally (${best.score}) by ` +
              `"${best.parser.domain}" (${best.plugin}) and "${second.parser.domain}" (${second.plugin})` +
              ` — pick one explicitly`,
          },
        };
      }
      chosen = { plugin: best.plugin, parser: best.parser };
    }

    const { plugin, parser } = chosen;
    const documents: GraphDocument[] = [];
    const deltas: DeltaWire[] = [];
    let closed = false;
    const sink = {
      emitDocument: (doc: GraphDocument) => {
        if (closed) throw new Error('ingest sink is closed (ADR-0009: no emissions after ingest resolves)');
        documents.push(doc);
      },
      emitDelta: (delta: DeltaWire) => {
        if (closed) throw new Error('ingest sink is closed (ADR-0009: no emissions after ingest resolves)');
        deltas.push(delta);
      },
      progress: (p: Progress) => {
        if (!closed) opts.onProgress?.(p);
      },
    };

    const started = Date.now();
    try {
      await parser.ingest(src, sink);
    } catch (e) {
      closed = true;
      return {
        ok: false,
        issue: {
          code: 'ingest-failed',
          message:
            `"${parser.domain}" parser failed after emitting ${documents.length} document(s), ` +
            `${deltas.length} delta(s) — nothing was kept (atomic rollback): ${message(e)}`,
          plugin,
        },
      };
    }
    closed = true;

    let graphs = 0;
    let nodes = 0;
    let edges = 0;
    const provenance = { source: 0, derived: 0, ai: 0 };
    const tally = (origin: string) => {
      if (origin === 'source' || origin === 'derived' || origin === 'ai') provenance[origin] += 1;
    };
    for (const doc of documents) {
      graphs += doc.graphs.length;
      for (const g of doc.graphs) {
        nodes += g.nodes.length;
        edges += g.edges.length;
        tally(g.meta.provenance.origin);
        for (const n of g.nodes) tally(n.provenance.origin);
        for (const e of g.edges) tally(e.provenance.origin);
      }
    }
    const report: IngestReport = {
      plugin,
      domain: parser.domain,
      source: src.uri,
      documents: documents.length,
      deltas: deltas.length,
      graphs,
      nodes,
      edges,
      provenance,
      warnings,
      elapsedMs: Date.now() - started,
    };
    return { ok: true, plugin, domain: parser.domain, documents, deltas, report };
  }

  #refuse(issue: HostIssue): RegisterResult {
    this.#log.warn(issue.message);
    return { ok: false, issue };
  }
}

export function createPluginHost(opts: HostOptions): PluginHost {
  return new PluginHost(opts);
}
