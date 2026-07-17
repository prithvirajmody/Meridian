/**
 * `CodeIncrementalSession` — the code adapter's {@link IncrementalAdapter} (7G,
 * ROADMAP §5/§7). It holds the prior parse (the mapped modules + the eager
 * document + any hot bodies) so a single file change re-parses **only that
 * file** and emits a **minimal**, store-valid `GraphDelta` through the ordinary
 * sink (ADR-0005 — one write path).
 *
 * The minimality guarantees come from two places, not from cleverness here:
 * - IDs are text-independent (ADR-0028) — derived from `(path, qualifiedName)`,
 *   never offsets — so unrelated edits reuse ids and the differ sees no change;
 * - {@link ./diff.js diffCodeDocuments} excludes byte spans, so a whitespace-only
 *   edit yields an **empty** delta (the flagship invariant).
 *
 * **Lazy-body composition** (ADR-0027): the eager graph re-diffs every update,
 * but bodies re-materialize only where they are already **hot** (resolved via
 * {@link resolveBody}). A cold body is never touched (nothing is in the store to
 * invalidate); a hot body in the changed file is re-resolved and diffed — an
 * unchanged function yields an empty body delta, a changed one a minimal delta
 * over its own subtree; a hot function that was removed/renamed is torn down
 * (detail cleared, body graphs removed) *before* the eager diff removes its node.
 */
import type {
  DetailContext,
  GraphDocument,
  IdFacade,
  IncrementalAdapter,
  IngestSink,
  PluginContext,
  SourceChange,
} from '@meridian/plugin-api';
import type { BundleFile } from '../bundle.js';
import { normalizePosixPath } from '../bundle.js';
import { DetailResolveError } from '../detail/build-detail.js';
import { buildCodeDocument } from '../document.js';
import { languageForPath } from '../languages.js';
import { assembleProject } from '../map/assemble.js';
import { mapFileToModule } from '../map/map-file.js';
import type { RawModule } from '../map/raw.js';
import type { CodeMapper } from '../mapper.js';
import { buildBodyGraphs } from './body-graphs.js';
import { diffCodeDocuments } from './diff.js';
import type { Op, WireGraph, WireNode } from './wire.js';

/** The origin actor stamped on an incremental delta. */
export const INCREMENTAL_ACTOR = 'code:incremental';

export interface CodeIncrementalSessionDeps {
  /** Grammar-runtime seam (worker in production, in-process in tests). */
  readonly mapper: Pick<CodeMapper, 'mapModule' | 'resolveBody'>;
  /** Deterministic id derivation (ADR-0002/0028) — the composition root's. */
  readonly ids: IdFacade;
  /** Producer version stamped into the eager document (defaults to the adapter's). */
  readonly producerVersion?: string;
}

/** Initial project state the session is seeded with (composition root owns I/O). */
export interface CodeProjectState {
  /** Ingest-root basename — the `code:project` label / ADR-0028 root source. */
  readonly root: string;
  readonly files: readonly BundleFile[];
}

interface HotBody {
  readonly source: string;
  /** The graph the function node lives in (its detail's host — for teardown). */
  readonly parentGraphId: string;
  /** The body's materialized graphs, as last emitted (for the next diff). */
  readonly graphs: readonly WireGraph[];
}

function emptyDoc(): GraphDocument {
  return { formatVersion: 1, producer: { name: '@meridian/adapter-code', version: '0' }, roots: [], graphs: [] };
}

function docOf(graphs: readonly WireGraph[]): GraphDocument {
  return { formatVersion: 1, producer: { name: '@meridian/adapter-code', version: '0' }, roots: [], graphs: [...graphs] };
}

/**
 * Create an incremental session over an initial project. Maps every file up
 * front (the eager pass) so the first `update` already has a baseline to diff.
 */
export async function createCodeIncrementalSession(
  deps: CodeIncrementalSessionDeps,
  initial: CodeProjectState,
): Promise<CodeIncrementalSession> {
  const session = new CodeIncrementalSession(deps, initial.root);
  for (const file of initial.files) {
    const source = normalizePosixPath(file.path);
    session.texts.set(source, file.text);
    const module = await mapFileToModule(deps.mapper, file);
    if (module !== undefined) session.modules.set(module.source, module);
  }
  session.rebuild();
  return session;
}

export class CodeIncrementalSession implements IncrementalAdapter {
  /** file source → current text (needed to re-parse a hot body). */
  readonly texts = new Map<string, string>();
  /** file source → mapped module skeleton (the cached eager parse). */
  readonly modules = new Map<string, RawModule>();
  private eagerDoc: GraphDocument = emptyDoc();
  private readonly hotBodies = new Map<string, HotBody>();
  private readonly ctx: PluginContext;
  private readonly producerVersion: string;

  constructor(
    private readonly deps: CodeIncrementalSessionDeps,
    private readonly root: string,
  ) {
    this.producerVersion = deps.producerVersion ?? '0.2.0';
    this.ctx = { apiVersion: '', ids: deps.ids, log: { info: () => undefined, warn: () => undefined } };
  }

  /** The current eager document (the store seed / baseline). */
  document(): GraphDocument {
    return this.eagerDoc;
  }

  /** Ids of currently-hot (materialized) function/method bodies (for tests). */
  hotBodyIds(): string[] {
    return [...this.hotBodies.keys()].sort();
  }

  /** Rebuild the eager document from the current module set (pure, no parse). */
  rebuild(): void {
    const tree = assembleProject(this.root, [...this.modules.values()]);
    this.eagerDoc = buildCodeDocument(this.ctx, tree, this.producerVersion);
  }

  /** Locate a node and its containing graph in the current eager document. */
  private locate(nodeId: string): { node: WireNode; graphId: string } | undefined {
    for (const g of this.eagerDoc.graphs) {
      for (const n of g.nodes) if (n.id === nodeId) return { node: n, graphId: g.id };
    }
    return undefined;
  }

  /**
   * Materialize a cold function/method body (drill-in) and mark it hot, emitting
   * the materialization delta through `sink`. Mirrors the standalone
   * `DetailResolver`, but the *session* retains the body so a later edit can
   * re-diff it (ADR-0027 composition). Idempotent: re-resolving a hot body emits
   * an empty delta.
   */
  async resolveBody(nodeId: string, sink: IngestSink, ctx?: Pick<DetailContext, 'signal'>): Promise<{ graph: string }> {
    const found = this.locate(nodeId);
    if (found === undefined) throw new DetailResolveError(`code incremental: node "${nodeId}" is not in the current graph`);
    const existing = this.hotBodies.get(nodeId);
    const graphs = await this.materializeBody(found.node, ctx?.signal);
    if (graphs === undefined) throw new DetailResolveError(`code incremental: node "${nodeId}" has no resolvable body`);
    const detail = graphs.graphs[graphs.graphs.length - 1]!.id; // CFG is last

    if (existing !== undefined) {
      // Already hot — re-diff (a redundant drill-in is an empty delta).
      const ops = diffCodeDocuments(docOf(existing.graphs), docOf(graphs.graphs));
      sink.emitDelta({ ops, origin: { actor: INCREMENTAL_ACTOR } });
    } else {
      const ops = diffCodeDocuments(emptyDoc(), docOf(graphs.graphs));
      ops.push({ t: 'node:detail', graph: found.graphId, id: nodeId, next: { graph: detail } });
      sink.emitDelta({ ops, origin: { actor: INCREMENTAL_ACTOR } });
    }
    await sink.drain?.();
    this.hotBodies.set(nodeId, { source: found.node.provenance.uri!, parentGraphId: found.graphId, graphs: graphs.graphs });
    return { graph: detail };
  }

  /** Re-parse and rebuild `node`'s body graphs, or `undefined` if it has none. */
  private async materializeBody(
    node: WireNode,
    signal?: AbortSignal,
  ): Promise<{ graphs: readonly WireGraph[] } | undefined> {
    const source = node.provenance.uri;
    const span = node.provenance.span;
    if (source === undefined || span === undefined) return undefined;
    const language = languageForPath(source);
    const text = this.texts.get(source);
    if (language === undefined || text === undefined) return undefined;
    const body = await this.deps.mapper.resolveBody(
      { language, source, text, declSpan: [span[0], span[1]] },
      signal !== undefined ? { signal } : {},
    );
    if (body === undefined) return undefined;
    return buildBodyGraphs(this.deps.ids, node, body);
  }

  /** Teardown ops for a hot function that vanished: clear its detail, then
   * remove its body graphs (ordered so the eager `node:remove` that follows
   * sees a cold node and the CFG graph is uncontained before removal). */
  private teardownBody(nodeId: string, hot: HotBody): Op[] {
    const ops: Op[] = [{ t: 'node:detail', graph: hot.parentGraphId, id: nodeId }];
    ops.push(...diffCodeDocuments(docOf(hot.graphs), emptyDoc()));
    return ops;
  }

  /**
   * Apply one file change: re-map the file, rebuild the eager document, and emit
   * a single minimal delta = [hot-body teardown] · [eager diff] · [hot-body
   * re-diff]. A no-op change (unchanged content, whitespace-only, or a non-code
   * file) emits an **empty** delta.
   */
  async update(change: SourceChange, sink: IngestSink): Promise<void> {
    const source = normalizePosixPath(change.path);
    // 1. Fold the change into the module set.
    if (change.newText === undefined) {
      this.texts.delete(source);
      this.modules.delete(source);
    } else {
      const module = await mapFileToModule(this.deps.mapper, { path: source, text: change.newText });
      if (module === undefined) {
        // Not a routed code file — nothing graph-shaped changed.
        sink.emitDelta({ ops: [], origin: { actor: INCREMENTAL_ACTOR } });
        await sink.drain?.();
        return;
      }
      this.texts.set(source, change.newText);
      this.modules.set(source, module);
    }

    // 2. Rebuild the eager document.
    const oldDoc = this.eagerDoc;
    this.rebuild();
    const newDoc = this.eagerDoc;

    // 3. Compose hot bodies in the changed file (ADR-0027): teardown vanished
    //    ones, re-diff surviving ones. Cold bodies (not tracked) stay cold.
    const teardownOps: Op[] = [];
    const bodyOps: Op[] = [];
    for (const [funcId, hot] of [...this.hotBodies].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (hot.source !== source) continue; // a hot body in another file is unaffected
      const found = this.locate(funcId);
      if (found === undefined) {
        teardownOps.push(...this.teardownBody(funcId, hot));
        this.hotBodies.delete(funcId);
        continue;
      }
      const graphs = await this.materializeBody(found.node);
      if (graphs === undefined) {
        // The function lost its body (e.g. became abstract) — tear it down.
        teardownOps.push(...this.teardownBody(funcId, hot));
        this.hotBodies.delete(funcId);
        continue;
      }
      bodyOps.push(...diffCodeDocuments(docOf(hot.graphs), docOf(graphs.graphs)));
      this.hotBodies.set(funcId, { source, parentGraphId: found.graphId, graphs: graphs.graphs });
    }

    // 4. Eager diff, sandwiched between teardown (before its node:remove) and
    //    the surviving-body re-diffs (disjoint graphs, order-independent).
    const eagerOps = diffCodeDocuments(oldDoc, newDoc);
    const ops = [...teardownOps, ...eagerOps, ...bodyOps];
    sink.emitDelta({ ops, origin: { actor: INCREMENTAL_ACTOR } });
    await sink.drain?.();
  }
}
