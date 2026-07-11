/**
 * `meridian layout` — the CLI as a thin driver over the layout engine
 * (ROADMAP Phase 4 §3, §6; subphase 4B). It wires the real pipeline
 * end-to-end: document → GraphSpace (graph-core `decode`) → default level
 * chain → `resolveLod` (the visible cut + induced edges, Phase 3) →
 * `LayoutProvider.compute` (grid/tree, ADR-0015) → SVG snapshot (DOM-free
 * exporter). No semantic or geometric computation lives here (§20): the
 * provider is the pure function of record; this module selects the request,
 * supplies presentation sizes, and writes files.
 *
 * Provider selection (ADR-0018): an explicit `--provider` flag wins; when it is
 * **absent**, the CLI defers to the pure `chooseProvider` heuristic — layered
 * for DAG-ish cuts, force for cluster-ish, tree for forests, grid for soup /
 * single nodes — computed from the resolved `(cut, inducedEdges)`. This
 * reconciles the 4B "default = grid" contract with ADR-0018: the *engine picks
 * per view shape* whenever the caller does not name a provider (the level-0 cut
 * of every corpus doc is a single title node, so the heuristic still returns
 * `grid` there — rule 1). The JSON/text output reports the provider actually
 * used and whether it was defaulted.
 *
 * Node sizes: layout providers place boxes, they never invent sizes
 * (ADR-0015), so the composition root must supply them. The CLI derives a
 * deterministic world-unit box from each node's label length — a presentation
 * choice that lives here, not in the layout package.
 *
 * Output is deterministic (I6): the exporter emits normalized SVG (sorted
 * elements, fixed precision, LF), so identical documents yield byte-identical
 * files — the golden contract.
 */
import { readFile, writeFile } from 'node:fs/promises';
import {
  buildContainmentIndex,
  containmentPathOf,
  decode,
  type GraphSpace,
  type Issue,
  type NodeId,
  type SemanticNode,
} from '@meridian/graph-core';
import type { Cut } from '@meridian/abstraction';
import {
  buildLevelChain,
  maxLevelOf,
  resolveLod,
  type LevelChain,
  type ZoomPolicy,
} from '@meridian/abstraction';
import {
  BUILTIN_LAYOUT_PROVIDERS,
  chooseProvider,
  exportSvg,
  LayoutWorkerHost,
  type CompoundNesting,
  type LayoutInput,
  type LayoutResult,
  type Size,
} from '@meridian/layout';
import { nodeWorkerFactory } from './layout-worker.js';

function out(line: string): void {
  process.stdout.write(line + '\n');
}

function formatIssue(issue: Issue): string {
  const location = issue.path !== undefined ? `at ${issue.path}: ` : '';
  return `[${issue.code}] ${location}${issue.message}`;
}

async function readDocument(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (e) {
    process.stderr.write(`cannot read ${file}: ${(e as Error).message}\n`);
    process.exit(2);
  }
}

/** Same canonical policy as `meridian cut`: `L` evenly-spaced bands, no
 * hysteresis, no budget — a `layout` is a fresh, stateless resolve. */
function canonicalPolicy(chain: LevelChain): ZoomPolicy {
  const bands = Math.max(1, chain.depth);
  const thresholds: number[] = [];
  for (let i = 1; i < bands; i++) thresholds.push(i / bands);
  return { thresholds, hysteresis: 0 };
}

function zoomForLevel(chain: LevelChain, level: number): number {
  const bands = Math.max(1, chain.depth);
  return (level + 0.5) / bands;
}

function indexNodes(space: GraphSpace): Map<string, SemanticNode> {
  const index = new Map<string, SemanticNode>();
  for (const graph of space.graphs.values()) {
    for (const node of graph.nodes.values()) index.set(node.id, node);
  }
  return index;
}

/** Deterministic world-unit box for a node: wide enough for its label at the
 * exporter's default font, fixed height. Presentation lives at the
 * composition root — providers only place the box (ADR-0015). */
function sizeForLabel(label: string): Size {
  const width = Math.max(60, Math.min(240, 16 + 7 * label.length));
  return { width, height: 28 };
}

/** Stable short form of a number for display (I6). */
function fmt(v: number): string {
  return Number(v.toFixed(2)).toString();
}

/**
 * Compound nesting for the `elk-layered` provider (ADR-0015/4D): each member's
 * container group is its own graph (`CutMember.graph`), and groups nest per the
 * graph-containment forest (`containmentPathOf`). "Nested graphs become ELK
 * compound nodes." Real cuts are antichains, so no *member* contains another —
 * but their *graphs* do, and elk lays that nesting out. Group keys are graph
 * ids; the containers are layout scaffolding, never rendered (ADR-0015).
 */
function buildCompound(space: GraphSpace, cut: Cut): CompoundNesting {
  const idx = buildContainmentIndex(space);
  const groupOf = new Map<NodeId, string>();
  const parentOf = new Map<string, string>();
  for (const id of cut.members) {
    const graph = cut.trace.get(id)?.graph;
    if (graph === undefined) continue;
    groupOf.set(id, String(graph));
    const path = containmentPathOf(space, graph, idx); // [root, …, graph]
    for (let i = 1; i < path.length; i++) parentOf.set(String(path[i]), String(path[i - 1]));
  }
  return { groupOf, parentOf };
}

export interface LayoutOptions {
  readonly json: boolean;
  /** Output SVG path (required). */
  readonly svg: string;
  /** Provider id; validated against the built-in registry. When omitted, the
   * ADR-0018 `chooseProvider` heuristic picks per view shape. */
  readonly provider?: string;
  /** A base containment level (≥ 0); default 0 (coarsest). */
  readonly level?: number;
  /** A raw zoom scalar in `[0,1]` (alternative to `--level`). */
  readonly zoom?: number;
  /** Run the provider inside the ADR-0017 Comlink worker host (4C) instead of
   * on the main thread. Output is byte-identical — the goldens prove it. */
  readonly worker?: boolean;
}

export async function cmdLayout(file: string, opts: LayoutOptions): Promise<number> {
  // An explicit --provider is validated up front (before any work); the default
  // is chosen from the resolved cut below (ADR-0018).
  if (opts.provider !== undefined && !BUILTIN_LAYOUT_PROVIDERS.has(opts.provider)) {
    const known = [...BUILTIN_LAYOUT_PROVIDERS.keys()].join(', ');
    process.stderr.write(`layout: unknown provider "${opts.provider}" (available: ${known})\n`);
    return 2;
  }

  const text = await readDocument(file);
  const decoded = decode(text);
  if (!decoded.ok) {
    out(`INVALID ${file}`);
    for (const issue of decoded.errors) out(`  ${formatIssue(issue)}`);
    return 1;
  }
  const space = decoded.space;
  const index = indexNodes(space);

  const chain = buildLevelChain(space);
  const level = opts.level ?? (opts.zoom === undefined ? 0 : undefined);
  const zoom = level !== undefined ? zoomForLevel(chain, level) : opts.zoom!;
  const policy = canonicalPolicy(chain);
  const result = resolveLod(space, chain, policy, { zoom, overrides: new Map() });
  const cut = result.cut;

  // Provider selection (ADR-0018): explicit flag wins; otherwise the pure
  // heuristic picks per view shape from the resolved (cut, inducedEdges).
  const defaulted = opts.provider === undefined;
  const providerId = defaulted ? chooseProvider(cut, result.inducedEdges) : opts.provider!;
  const provider = BUILTIN_LAYOUT_PROVIDERS.get(providerId)!;

  const sizes = new Map<NodeId, Size>();
  const labels = new Map<NodeId, string>();
  for (const id of cut.members) {
    const label = index.get(id)?.label ?? '';
    sizes.set(id, sizeForLabel(label));
    labels.set(id, label);
  }

  // elk-layered is compound-aware: nest members under their graphs (invisible
  // containers). The flat providers (grid/tree) ignore `compound`.
  const compound = provider.id === 'elk-layered' ? buildCompound(space, cut) : undefined;
  const input: LayoutInput = {
    cut,
    edges: result.inducedEdges,
    sizes,
    hints: {},
    ...(compound !== undefined ? { compound } : {}),
  };
  let layout: LayoutResult;
  if (opts.worker) {
    // Run the provider off the main thread in the ADR-0017 worker host. The
    // geometry is byte-identical to the main-thread path (the goldens prove
    // it); on a provider crash the host falls back to grid (degraded).
    const host = new LayoutWorkerHost({ factory: nodeWorkerFactory() });
    try {
      const hosted = await host.compute(provider.id, input);
      layout = hosted.layout;
    } finally {
      await host.dispose();
    }
  } else {
    layout = await provider.compute(input);
  }
  const svg = exportSvg(layout, result.inducedEdges, { labels });

  try {
    await writeFile(opts.svg, svg, 'utf8');
  } catch (e) {
    process.stderr.write(`cannot write ${opts.svg}: ${(e as Error).message}\n`);
    return 2;
  }

  const b = layout.bounds;
  if (opts.json) {
    out(
      JSON.stringify(
        {
          file,
          ok: true,
          provider: provider.id,
          providerDefaulted: defaulted,
          level: cut.level,
          maxLevel: maxLevelOf(chain),
          zoom,
          nodes: cut.members.length,
          inducedEdges: result.inducedEdges.length,
          bounds: b,
          stability: layout.stability,
          svg: opts.svg,
        },
        null,
        2,
      ),
    );
  } else {
    out(
      `layout ${file} — provider ${provider.id}${defaulted ? ' (default, ADR-0018)' : ''} · level ${cut.level}/${maxLevelOf(chain)}`,
    );
    out(`  nodes      ${cut.members.length}`);
    out(`  edges      ${result.inducedEdges.length} induced`);
    out(`  bounds     ${fmt(b.width)} × ${fmt(b.height)} at (${fmt(b.x)}, ${fmt(b.y)})`);
    out(`  stability  ${fmt(layout.stability)}`);
    out(`  wrote ${opts.svg}`);
  }
  return 0;
}
