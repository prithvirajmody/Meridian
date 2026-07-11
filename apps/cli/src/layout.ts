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
 * Provider selection is an **explicit `--provider` flag with a plain default
 * of `grid`** — the ADR-0018 `chooseProvider` heuristic is subphase 4E and
 * deliberately absent here.
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
  decode,
  type GraphSpace,
  type Issue,
  type NodeId,
  type SemanticNode,
} from '@meridian/graph-core';
import {
  buildLevelChain,
  maxLevelOf,
  resolveLod,
  type LevelChain,
  type ZoomPolicy,
} from '@meridian/abstraction';
import {
  BUILTIN_LAYOUT_PROVIDERS,
  exportSvg,
  type LayoutInput,
  type Size,
} from '@meridian/layout';

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

export interface LayoutOptions {
  readonly json: boolean;
  /** Output SVG path (required). */
  readonly svg: string;
  /** Provider id; validated against the built-in registry. Default `grid`. */
  readonly provider: string;
  /** A base containment level (≥ 0); default 0 (coarsest). */
  readonly level?: number;
  /** A raw zoom scalar in `[0,1]` (alternative to `--level`). */
  readonly zoom?: number;
}

export async function cmdLayout(file: string, opts: LayoutOptions): Promise<number> {
  const provider = BUILTIN_LAYOUT_PROVIDERS.get(opts.provider);
  if (provider === undefined) {
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

  const sizes = new Map<NodeId, Size>();
  const labels = new Map<NodeId, string>();
  for (const id of cut.members) {
    const label = index.get(id)?.label ?? '';
    sizes.set(id, sizeForLabel(label));
    labels.set(id, label);
  }

  const input: LayoutInput = { cut, edges: result.inducedEdges, sizes, hints: {} };
  const layout = await provider.compute(input);
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
    out(`layout ${file} — provider ${provider.id} · level ${cut.level}/${maxLevelOf(chain)}`);
    out(`  nodes      ${cut.members.length}`);
    out(`  edges      ${result.inducedEdges.length} induced`);
    out(`  bounds     ${fmt(b.width)} × ${fmt(b.height)} at (${fmt(b.x)}, ${fmt(b.y)})`);
    out(`  stability  ${fmt(layout.stability)}`);
    out(`  wrote ${opts.svg}`);
  }
  return 0;
}
