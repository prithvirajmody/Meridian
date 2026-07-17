/**
 * The runtime-neutral heart of the backend (ADR-0038 §5): op log first,
 * element tables as a write-behind checkpoint.
 *
 * - `appendDelta` — one SQLite transaction per committed delta (continuous
 *   autosave, §15.3).
 * - `enqueueChange`/`flushSync` — element materialization every
 *   `checkpointEvery` deltas and on flush/close; `meta.checkpoint_seq` marks
 *   how far the tables reflect the log.
 * - `open` — load the checkpoint, replay the oplog tail through a transient
 *   store (op-level `prev` assertions give conflict detection, ADR-0005),
 *   then finish the checkpoint. Any prefix of appended transactions is a
 *   valid project — that is the whole recovery story.
 *
 * Volatile commits (ADR-0039) never reach this class: the store filters
 * them before the backend seam.
 */
import {
  MeridianError,
  type GraphId,
  type GraphMeta,
  type GraphSpace,
  type SemanticEdge,
  type SemanticGraph,
  type SemanticNode,
} from '@meridian/graph-core';
import {
  createStore,
  decodeDelta,
  deltaToWire,
  LOCAL_SITE,
  type ChangeSet,
  type GraphDelta,
  type GraphManifestEntry,
  type GraphOp,
  type StorageBackend,
  type VersionStamp,
} from '@meridian/graph-store';
import type { SqlDriver, SqlValue } from './driver.js';
import {
  META_CHECKPOINT_SEQ,
  META_LAST_COUNTER,
  readMetaValue,
  writeMetaValue,
} from './schema.js';
import {
  attrsToJson,
  edgeRowParams,
  graphRowParams,
  jsonToAttrs,
  nodeRowParams,
  provenanceToJson,
  rowToEdge,
  rowToMeta,
  rowToNode,
} from './rows.js';

export const DEFAULT_CHECKPOINT_EVERY = 64;

export interface CoreOptions {
  /** Materialize element tables every N committed deltas (ADR-0038 §5). */
  readonly checkpointEvery?: number;
  /**
   * Cold open (ADR-0039): the returned space is the top slab — root graphs
   * hydrated, their children as empty shells — plus the full graph manifest
   * for a `HydrationManager`, instead of the fully materialized space.
   */
  readonly cold?: boolean;
}

export interface OpenedState {
  readonly space: GraphSpace;
  readonly version: VersionStamp;
  /** Oplog tail deltas replayed beyond the checkpoint (0 = clean close). */
  readonly replayedDeltas: number;
  /** Identity + summary metadata per graph — present on cold opens. */
  readonly manifest?: ReadonlyMap<GraphId, GraphManifestEntry>;
}

/** Per-graph element counts — the ADR-0039 cold-graph summary manifest. */
export interface GraphSummary {
  readonly nodeCount: number;
  readonly edgeCount: number;
}

function readIntMeta(db: SqlDriver, key: string): number {
  const raw = readMetaValue(db, key);
  const n = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new MeridianError('storage-corrupt', `meta.${key} is ${JSON.stringify(raw)} — expected a non-negative integer`);
  }
  return n;
}

export class SqliteBackendCore {
  private readonly db: SqlDriver;
  private readonly checkpointEvery: number;
  private queue: Array<readonly GraphOp[]> = [];
  private lastAppendedSeq: number;
  /** Durable head observed when this core opened. Compared under the SQLite
   * writer lease before every append so a second, stale project instance
   * cannot write a duplicate logical version after the first writer commits. */
  private lastDurableCounter: number;
  private deadReason: string | undefined;

  private constructor(db: SqlDriver, opts: CoreOptions, headSeq: number, durableCounter: number) {
    this.db = db;
    this.checkpointEvery = Math.max(1, opts.checkpointEvery ?? DEFAULT_CHECKPOINT_EVERY);
    this.lastAppendedSeq = headSeq;
    this.lastDurableCounter = durableCounter;
  }

  /** Full checkpoint of `space` into a freshly initialized schema. */
  static create(db: SqlDriver, space: GraphSpace, opts: CoreOptions = {}): SqliteBackendCore {
    db.transaction(() => {
      for (const [graphId, graph] of space.graphs) {
        db.run(
          'INSERT INTO graphs (id, label, domain, provenance, node_count, edge_count) VALUES (?, ?, ?, ?, ?, ?)',
          [...graphRowParams(graphId, graph.meta), graph.nodes.size, graph.edges.size],
        );
        for (const node of graph.nodes.values()) {
          db.run(
            'INSERT INTO nodes (id, graph_id, kind, label, detail_graph, attrs, provenance) VALUES (?, ?, ?, ?, ?, ?, ?)',
            nodeRowParams(graphId, node),
          );
        }
        for (const edge of graph.edges.values()) {
          db.run(
            'INSERT INTO edges (id, graph_id, src, dst, kind, weight, attrs, provenance) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            edgeRowParams(graphId, edge),
          );
        }
      }
    });
    return new SqliteBackendCore(db, opts, 0, 0);
  }

  /**
   * Open an existing project: checkpoint + tail replay (ADR-0038 §5). The
   * caller has already run the integrity gate and migrations.
   */
  static open(db: SqlDriver, opts: CoreOptions = {}): { core: SqliteBackendCore; opened: OpenedState } {
    const checkpointSeq = readIntMeta(db, META_CHECKPOINT_SEQ);
    const lastCounter = readIntMeta(db, META_LAST_COUNTER);
    const headRow = db.get('SELECT COALESCE(MAX(seq), 0) AS head FROM oplog');
    const headSeq = Number(headRow?.head ?? 0);
    if (checkpointSeq > headSeq) {
      throw new MeridianError(
        'storage-corrupt',
        `meta.checkpoint_seq (${checkpointSeq}) is beyond the op log head (${headSeq}) — the log has been truncated`,
      );
    }

    const core = new SqliteBackendCore(db, opts, headSeq, lastCounter);
    let fullSpace: GraphSpace | undefined;
    let replayed = 0;

    if (headSeq > checkpointSeq) {
      // Replay through a real store: one validation of the checkpoint, then
      // op-level prev assertions guard every replayed delta. Recovery always
      // works on the full space — after the checkpoint is finished, a cold
      // open rereads the (now current) tables.
      const replayStore = createStore(loadSpace(db));
      const tail = db.all('SELECT seq, ops FROM oplog WHERE seq > ? ORDER BY seq', [checkpointSeq]);
      for (const row of tail) {
        const parsed: unknown = JSON.parse(String(row.ops));
        const decoded = decodeDelta(parsed);
        if (!decoded.ok) {
          throw new MeridianError(
            'storage-corrupt',
            `op log row seq ${String(row.seq)} does not decode: ${decoded.errors[0]!.message}`,
          );
        }
        const applied = replayStore.apply({ origin: decoded.delta.origin, ops: decoded.delta.ops });
        if (!applied.ok) {
          throw new MeridianError(
            'storage-corrupt',
            `op log row seq ${String(row.seq)} does not apply cleanly: [${applied.errors[0]!.code}] ${applied.errors[0]!.message}`,
          );
        }
        core.queue.push(applied.changes.ops);
        replayed += 1;
      }
      fullSpace = replayStore.snapshot();
      core.flushSync(); // finish the interrupted checkpoint
    }

    const cold = opts.cold === true;
    const space = cold ? loadColdSpine(db) : (fullSpace ?? loadSpace(db));
    return {
      core,
      opened: {
        space,
        version: { counter: lastCounter, site: LOCAL_SITE },
        replayedDeltas: replayed,
        ...(cold ? { manifest: loadManifest(db) } : {}),
      },
    };
  }

  /** Durable op-log append — one SQLite transaction per committed delta. */
  appendDelta(delta: GraphDelta): void {
    this.assertAlive();
    const committedCounter = delta.baseVersion.counter + 1;
    const wire = JSON.stringify(deltaToWire({ origin: { actor: delta.origin.actor }, ops: delta.ops }));
    try {
      this.db.transaction(() => {
        const durableHead = readIntMeta(this.db, META_LAST_COUNTER);
        if (durableHead !== this.lastDurableCounter) {
          throw new MeridianError(
            'storage-busy',
            `project durable head advanced from ${this.lastDurableCounter} to ${durableHead} in another writer — close this stale session and reopen (ADR-0038 single-writer contract)`,
          );
        }
        this.db.run('INSERT INTO oplog (counter, site, actor, ops) VALUES (?, ?, ?, ?)', [
          committedCounter,
          delta.baseVersion.site,
          delta.origin.actor,
          wire,
        ]);
        writeMetaValue(this.db, META_LAST_COUNTER, String(committedCounter));
      });
    } catch (e) {
      this.die(e, `op-log append for durable version ${committedCounter}`);
    }
    const row = this.db.get('SELECT last_insert_rowid() AS seq');
    this.lastAppendedSeq = Number(row?.seq ?? this.lastAppendedSeq + 1);
    this.lastDurableCounter = committedCounter;
  }

  /** Queue a committed change for materialization (write-behind checkpoint). */
  enqueueChange(change: ChangeSet): void {
    this.enqueueOps(change.ops);
  }

  /** Same, from a bare op list (the worker wire form, ADR-0038 browser). */
  enqueueOps(ops: readonly GraphOp[]): void {
    this.assertAlive();
    this.queue.push(ops);
    if (this.queue.length >= this.checkpointEvery) this.flushSync();
  }

  /** Materialize every queued change and advance `checkpoint_seq`. */
  flushSync(): void {
    this.assertAlive();
    if (this.queue.length === 0) return;
    const batches = this.queue;
    const upToSeq = this.lastAppendedSeq;
    try {
      this.db.transaction(() => {
        const countDeltas = new Map<string, { nodes: number; edges: number }>();
        for (const ops of batches) {
          for (const op of ops) this.materializeOp(op, countDeltas);
        }
        for (const [graphId, d] of countDeltas) {
          if (d.nodes !== 0 || d.edges !== 0) {
            this.db.run('UPDATE graphs SET node_count = node_count + ?, edge_count = edge_count + ? WHERE id = ?', [
              d.nodes,
              d.edges,
              graphId,
            ]);
          }
        }
        writeMetaValue(this.db, META_CHECKPOINT_SEQ, String(upToSeq));
      });
      this.queue = [];
    } catch (e) {
      this.die(e, `checkpoint through op-log seq ${upToSeq}`);
    }
  }

  /**
   * Load one graph's elements — the ADR-0039 hydration read. Flushes first
   * so the tables reflect every commit this session has made.
   */
  loadGraphSync(id: GraphId): SemanticGraph | null {
    this.assertAlive();
    if (this.queue.length > 0) this.flushSync();
    const graphRow = this.db.get('SELECT id, label, domain, provenance FROM graphs WHERE id = ?', [id]);
    if (graphRow === undefined) return null;
    const meta: GraphMeta = rowToMeta(graphRow);
    const nodes = new Map<SemanticNode['id'], SemanticNode>();
    for (const row of this.db.all(
      'SELECT id, kind, label, detail_graph, attrs, provenance FROM nodes WHERE graph_id = ? ORDER BY id',
      [id],
    )) {
      const node = rowToNode(row);
      nodes.set(node.id, node);
    }
    const edges = new Map<SemanticEdge['id'], SemanticEdge>();
    for (const row of this.db.all(
      'SELECT id, src, dst, kind, weight, attrs, provenance FROM edges WHERE graph_id = ? ORDER BY id',
      [id],
    )) {
      const edge = rowToEdge(row);
      edges.set(edge.id, edge);
    }
    return { id, meta, nodes, edges };
  }

  /** Per-graph counts (maintained at checkpoint) — the cold-graph manifest. */
  graphSummaries(): Map<GraphId, GraphSummary> {
    this.assertAlive();
    if (this.queue.length > 0) this.flushSync();
    const out = new Map<GraphId, GraphSummary>();
    for (const row of this.db.all('SELECT id, node_count, edge_count FROM graphs')) {
      out.set(String(row.id) as GraphId, {
        nodeCount: Number(row.node_count),
        edgeCount: Number(row.edge_count),
      });
    }
    return out;
  }

  evictHint(_ids: readonly GraphId[]): void {
    // Advisory (ADR-0038): nothing to do in v1 — eviction writes nothing.
  }

  /** Durability state: non-undefined means append/flush failed permanently. */
  get lostReason(): string | undefined {
    return this.deadReason;
  }

  close(): void {
    if (this.deadReason === undefined && this.queue.length > 0) this.flushSync();
    this.db.close();
  }

  // ------------------------------------------------------------- internals

  private assertAlive(): void {
    if (this.deadReason !== undefined) {
      throw new MeridianError('storage-io', `durability lost: ${this.deadReason} — export the session and reopen`);
    }
  }

  private die(e: unknown, location: string): never {
    this.deadReason = e instanceof Error ? e.message : String(e);
    throw new MeridianError(
      e instanceof MeridianError ? e.code : 'storage-io',
      `storage write failed during ${location}: ${this.deadReason}`,
    );
  }

  private materializeOp(op: GraphOp, counts: Map<string, { nodes: number; edges: number }>): void {
    const bump = (graph: string, nodes: number, edges: number): void => {
      const c = counts.get(graph) ?? { nodes: 0, edges: 0 };
      c.nodes += nodes;
      c.edges += edges;
      counts.set(graph, c);
    };
    switch (op.t) {
      case 'graph:add':
        this.db.run('INSERT INTO graphs (id, label, domain, provenance, node_count, edge_count) VALUES (?, ?, ?, ?, 0, 0)', [
          ...graphRowParams(op.graph, op.meta),
        ] as SqlValue[]);
        return;
      case 'graph:remove':
        this.db.run('DELETE FROM graphs WHERE id = ?', [op.graph]);
        counts.delete(op.graph);
        return;
      case 'graph:meta':
        this.db.run('UPDATE graphs SET label = ?, domain = ?, provenance = ? WHERE id = ?', [
          op.next.label,
          op.next.domain,
          provenanceToJson(op.next.provenance),
          op.graph,
        ]);
        return;
      case 'node:add':
        this.db.run(
          'INSERT INTO nodes (id, graph_id, kind, label, detail_graph, attrs, provenance) VALUES (?, ?, ?, ?, ?, ?, ?)',
          nodeRowParams(op.graph, op.node),
        );
        bump(op.graph, 1, 0);
        return;
      case 'node:remove':
        this.db.run('DELETE FROM nodes WHERE id = ?', [op.id]);
        bump(op.graph, -1, 0);
        return;
      case 'node:attr': {
        const row = this.db.get('SELECT attrs FROM nodes WHERE id = ?', [op.id]);
        const attrs = { ...jsonToAttrs(row?.attrs ?? null) };
        if (op.next === undefined) {
          delete attrs[op.key];
        } else {
          attrs[op.key] = op.next;
        }
        this.db.run('UPDATE nodes SET attrs = ? WHERE id = ?', [attrsToJson(attrs), op.id]);
        return;
      }
      case 'node:detail':
        this.db.run('UPDATE nodes SET detail_graph = ? WHERE id = ?', [op.next ? op.next.graph : null, op.id]);
        return;
      case 'edge:add':
        this.db.run(
          'INSERT INTO edges (id, graph_id, src, dst, kind, weight, attrs, provenance) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          edgeRowParams(op.graph, op.edge),
        );
        bump(op.graph, 0, 1);
        return;
      case 'edge:remove':
        this.db.run('DELETE FROM edges WHERE id = ?', [op.id]);
        bump(op.graph, 0, -1);
        return;
    }
  }
}

/** Read the full element checkpoint into a `GraphSpace` (roots derived). */
export function loadSpace(db: SqlDriver): GraphSpace {
  const graphs = new Map<GraphId, SemanticGraph>();
  const nodesByGraph = new Map<string, Map<SemanticNode['id'], SemanticNode>>();
  const edgesByGraph = new Map<string, Map<SemanticEdge['id'], SemanticEdge>>();
  const claimed = new Set<string>();

  for (const row of db.all('SELECT id, graph_id, kind, label, detail_graph, attrs, provenance FROM nodes ORDER BY id')) {
    const node = rowToNode(row);
    const graphId = String(row.graph_id);
    let bucket = nodesByGraph.get(graphId);
    if (!bucket) {
      bucket = new Map();
      nodesByGraph.set(graphId, bucket);
    }
    bucket.set(node.id, node);
    if (node.detail) claimed.add(node.detail.graph);
  }
  for (const row of db.all('SELECT id, graph_id, src, dst, kind, weight, attrs, provenance FROM edges ORDER BY id')) {
    const edge = rowToEdge(row);
    const graphId = String(row.graph_id);
    let bucket = edgesByGraph.get(graphId);
    if (!bucket) {
      bucket = new Map();
      edgesByGraph.set(graphId, bucket);
    }
    bucket.set(edge.id, edge);
  }
  const roots: GraphId[] = [];
  for (const row of db.all('SELECT id, label, domain, provenance FROM graphs ORDER BY id')) {
    const id = String(row.id) as GraphId;
    graphs.set(id, {
      id,
      meta: rowToMeta(row),
      nodes: nodesByGraph.get(id) ?? new Map(),
      edges: edgesByGraph.get(id) ?? new Map(),
    });
    if (!claimed.has(id)) roots.push(id);
  }
  roots.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { graphs, roots };
}

/** Full graph manifest: identity + summary counts (ADR-0039 cold sizing). */
export function loadManifest(db: SqlDriver): Map<GraphId, GraphManifestEntry> {
  const out = new Map<GraphId, GraphManifestEntry>();
  for (const row of db.all('SELECT id, label, domain, provenance, node_count, edge_count FROM graphs')) {
    out.set(String(row.id) as GraphId, {
      meta: rowToMeta(row),
      nodeCount: Number(row.node_count),
      edgeCount: Number(row.edge_count),
    });
  }
  return out;
}

/**
 * The cold-open top slab (ADR-0039 §2): root graphs hydrated, each child
 * graph their nodes claim present as an empty shell, deeper descendants
 * absent entirely. Roots stay truthful and U1 holds.
 */
export function loadColdSpine(db: SqlDriver): GraphSpace {
  const metas = new Map<GraphId, GraphMeta>();
  for (const row of db.all('SELECT id, label, domain, provenance FROM graphs ORDER BY id')) {
    metas.set(String(row.id) as GraphId, rowToMeta(row));
  }
  const claimed = new Set<string>();
  for (const row of db.all('SELECT DISTINCT detail_graph AS g FROM nodes WHERE detail_graph IS NOT NULL')) {
    claimed.add(String(row.g));
  }
  const roots = [...metas.keys()].filter((id) => !claimed.has(id)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const graphs = new Map<GraphId, SemanticGraph>();
  const shells = new Set<GraphId>();
  for (const id of roots) {
    const nodes = new Map<SemanticNode['id'], SemanticNode>();
    for (const row of db.all(
      'SELECT id, kind, label, detail_graph, attrs, provenance FROM nodes WHERE graph_id = ? ORDER BY id',
      [id],
    )) {
      const node = rowToNode(row);
      nodes.set(node.id, node);
      if (node.detail) shells.add(node.detail.graph);
    }
    const edges = new Map<SemanticEdge['id'], SemanticEdge>();
    for (const row of db.all(
      'SELECT id, src, dst, kind, weight, attrs, provenance FROM edges WHERE graph_id = ? ORDER BY id',
      [id],
    )) {
      const edge = rowToEdge(row);
      edges.set(edge.id, edge);
    }
    graphs.set(id, { id, meta: metas.get(id)!, nodes, edges });
  }
  for (const id of shells) {
    const meta = metas.get(id);
    if (meta === undefined) {
      throw new MeridianError('storage-corrupt', `cold open: node references graph "${id}" that has no graphs row`);
    }
    graphs.set(id, { id, meta, nodes: new Map(), edges: new Map() });
  }
  return { graphs, roots };
}

/**
 * Async `StorageBackend` facade over the synchronous core, serialized on an
 * internal FIFO so host-side `flush`/`close` order correctly against the
 * store's own post-commit notifications.
 */
export class SqliteStorageBackend implements StorageBackend {
  private chain: Promise<void> = Promise.resolve();

  constructor(readonly core: SqliteBackendCore) {}

  private enqueue<T>(fn: () => T): Promise<T> {
    const result = this.chain.then(fn);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  loadGraph(id: GraphId): Promise<SemanticGraph | null> {
    return this.enqueue(() => this.core.loadGraphSync(id));
  }

  persist(change: ChangeSet): Promise<void> {
    return this.enqueue(() => this.core.enqueueChange(change));
  }

  appendOps(delta: GraphDelta): Promise<void> {
    return this.enqueue(() => this.core.appendDelta(delta));
  }

  evictHint(ids: readonly GraphId[]): void {
    this.core.evictHint(ids);
  }

  /**
   * Settle: let the store's queued post-commit notifications land (they are
   * enqueued on microtasks after each commit), then materialize everything.
   * One macrotask hop strictly follows all pending microtasks.
   */
  async settle(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await this.enqueue(() => this.core.flushSync());
  }
}
