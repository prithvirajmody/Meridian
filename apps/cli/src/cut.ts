/**
 * `meridian cut` — the CLI as a thin driver over the abstraction engine
 * (ROADMAP Phase 3 §3, demo). It wires the real pipeline end-to-end:
 * document → GraphSpace (graph-core `decode`) → default level chain
 * (`buildLevelChain`) → `resolveLod` → the visible cut + induced edges — then
 * formats. No semantic computation lives here (§20): the resolver is the pure
 * function of record; this module only *selects the request* and *renders the
 * result*.
 *
 * Two request modes, exactly one required:
 *  - `--level N`  a base containment level (0 = coarsest); mapped to the zoom
 *    band center under a canonical evenly-spaced `ZoomPolicy` so it routes
 *    through the same `resolveLod` path as `--zoom`.
 *  - `--zoom z`   a raw zoom scalar in `[0,1]` (ADR-0012: 0 coarsest,
 *    1 finest).
 * `--focus <id>` is recorded in the trace and (with a budget) protects its
 * path from collapse; inert for the scalar→cut mapping in v1 (ADR-0012). No
 * node budget is applied at the CLI — a cut is the complete level view.
 *
 * Output is deterministic (I6): members and induced edges arrive pre-sorted
 * from the resolver; we only look up labels and print.
 */
import { readFile } from 'node:fs/promises';
import { stderrLine, stdoutLine } from './io.js';
import { chainSpecFor } from './level-chains.js';
import {
  decode,
  type GraphSpace,
  type Issue,
  type NodeId,
  type SemanticGraph,
  type SemanticNode,
} from '@meridian/graph-core';
import {
  buildLevelChain,
  maxLevelOf,
  resolveLod,
  type InducedEdge,
  type LevelChain,
  type LodResult,
  type ZoomPolicy,
} from '@meridian/abstraction';

function out(line: string): void {
  stdoutLine(line);
}

function formatIssue(issue: Issue): string {
  const location = issue.path !== undefined ? `at ${issue.path}: ` : '';
  return `[${issue.code}] ${location}${issue.message}`;
}

async function readDocument(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (e) {
    stderrLine(`cannot read ${file}: ${(e as Error).message}`);
    process.exit(2);
  }
}

/**
 * A canonical policy for the CLI: `L` evenly-spaced bands over `[0,1]`, no
 * hysteresis (a `cut` is a fresh, stateless resolve), no budget (the full
 * level view). `thresholds[k] = (k+1)/L`, so zoom band `k` is `[k/L,(k+1)/L)`.
 */
function canonicalPolicy(chain: LevelChain): ZoomPolicy {
  const bands = Math.max(1, chain.depth);
  const thresholds: number[] = [];
  for (let i = 1; i < bands; i++) thresholds.push(i / bands);
  return { thresholds, hysteresis: 0 };
}

/** The zoom at the center of band `level` — round-trips back to `level` under
 * {@link canonicalPolicy} (`nominalLevel` clamps past the finest band). */
function zoomForLevel(chain: LevelChain, level: number): number {
  const bands = Math.max(1, chain.depth);
  return (level + 0.5) / bands;
}

/** Stable short form of a zoom scalar for display (I6): trailing-zero-free,
 * ≤4 decimals. */
function fmtZoom(z: number): string {
  return Number(z.toFixed(4)).toString();
}

interface Located {
  readonly node: SemanticNode;
  readonly graph: SemanticGraph;
}

function indexNodes(space: GraphSpace): Map<string, Located> {
  const index = new Map<string, Located>();
  for (const graph of space.graphs.values()) {
    for (const node of graph.nodes.values()) index.set(node.id, { node, graph });
  }
  return index;
}

function labelOf(index: ReadonlyMap<string, Located>, id: NodeId): string {
  return index.get(id)?.node.label ?? '(?)';
}

/** The request mode, validated by the caller (main.ts) so usage errors exit 2
 * with help before any I/O. Exactly one of `level`/`zoom` is set. */
export interface CutOptions {
  readonly json: boolean;
  /** A base containment level (≥ 0); mapped to a zoom band center. */
  readonly level?: number;
  /** A raw zoom scalar in `[0,1]`. */
  readonly zoom?: number;
  readonly focus?: string;
}

function inducedJson(index: ReadonlyMap<string, Located>, e: InducedEdge): Record<string, unknown> {
  return {
    src: e.src,
    srcLabel: labelOf(index, e.src),
    dst: e.dst,
    dstLabel: labelOf(index, e.dst),
    kind: e.kind,
    weight: e.weight,
    multiplicity: e.multiplicity,
    samples: e.samples.map(String),
  };
}

function printJson(
  file: string,
  chain: LevelChain,
  result: LodResult,
  index: ReadonlyMap<string, Located>,
  zoom: number,
): void {
  const cut = result.cut;
  out(
    JSON.stringify(
      {
        file,
        ok: true,
        level: cut.level,
        maxLevel: maxLevelOf(chain),
        zoom,
        chain: { domain: chain.domain, depth: chain.depth, levels: chain.levels },
        coverage: cut.coverage,
        ...(result.provenance.focus !== undefined ? { focus: result.provenance.focus } : {}),
        cut: cut.members.map((id) => {
          const m = cut.trace.get(id)!;
          return {
            id,
            label: labelOf(index, id),
            kind: index.get(id)?.node.kind ?? '(?)',
            graph: m.graph,
            reason: m.reason,
            coveredLeaves: m.coveredLeaves,
          };
        }),
        inducedEdges: result.inducedEdges.map((e) => inducedJson(index, e)),
        cappedEdges: {
          edges: result.cappedEdges.edges.map((e) => inducedJson(index, e)),
          residuals: result.cappedEdges.residuals,
        },
        frontier: result.frontier,
        provenance: {
          zoom: result.provenance.zoom,
          nominalLevel: result.provenance.nominalLevel,
          level: result.provenance.level,
          ...(result.provenance.focus !== undefined ? { focus: result.provenance.focus } : {}),
          ignoredOverrides: result.provenance.ignoredOverrides,
        },
      },
      null,
      2,
    ),
  );
}

function printText(
  file: string,
  chain: LevelChain,
  result: LodResult,
  index: ReadonlyMap<string, Located>,
  zoom: number,
): void {
  const cut = result.cut;
  const max = maxLevelOf(chain);
  out(`cut ${file} — level ${cut.level}/${max} · zoom ${fmtZoom(zoom)}`);
  const names = chain.levels.map((l) => l.name);
  const chainNames = names.length > 0 ? ` (${names.join(' → ')})` : '';
  out(`  chain      ${chain.domain} · ${chain.depth} level${chain.depth === 1 ? '' : 's'}${chainNames}`);
  const cov = cut.coverage;
  out(`  coverage   ${cov.coveredLeaves}/${cov.leaves} leaves — ${cov.covers ? 'covers ✓' : 'INCOMPLETE ✗'}`);
  if (result.provenance.focus !== undefined) {
    out(`  focus      ${result.provenance.focus} "${labelOf(index, result.provenance.focus)}"`);
  }

  out(`  nodes (${cut.members.length}):`);
  for (const id of cut.members) {
    const m = cut.trace.get(id)!;
    const kind = index.get(id)?.node.kind ?? '(?)';
    out(`    ${id} "${labelOf(index, id)}" (${kind}) · ${m.reason} · covers ${m.coveredLeaves}`);
  }

  out(`  induced edges (${result.inducedEdges.length}):`);
  for (const e of result.inducedEdges) {
    const witnesses = e.multiplicity > e.samples.length ? `, +${e.multiplicity - e.samples.length} more` : '';
    out(
      `    ${e.src} "${labelOf(index, e.src)}" → ${e.dst} "${labelOf(index, e.dst)}" [${e.kind}] · weight ${e.weight} · ×${e.multiplicity} (${e.samples.join(', ')}${witnesses})`,
    );
  }
  for (const r of result.cappedEdges.residuals) {
    out(`    ${r.node} ${r.direction}: +${r.hidden} more (weight ${r.weight}, ×${r.multiplicity}) — fan-out cap`);
  }

  out(`  frontier   expandable ${result.frontier.expandable.length} · collapsible ${result.frontier.collapsible.length}`);
}

export async function cmdCut(file: string, opts: CutOptions): Promise<number> {
  const text = await readDocument(file);
  const decoded = decode(text);
  if (!decoded.ok) {
    out(`INVALID ${file}`);
    for (const issue of decoded.errors) out(`  ${formatIssue(issue)}`);
    return 1;
  }
  const space = decoded.space;
  const index = indexNodes(space);

  if (opts.focus !== undefined && !index.has(opts.focus)) {
    stderrLine(`focus node "${opts.focus}" not found in ${file}`);
    return 1;
  }

  const chain = buildLevelChain(space, chainSpecFor(space));
  const zoom = opts.level !== undefined ? zoomForLevel(chain, opts.level) : opts.zoom!;

  const policy = canonicalPolicy(chain);
  const result = resolveLod(space, chain, policy, {
    zoom,
    overrides: new Map(),
    ...(opts.focus !== undefined ? { focus: opts.focus as NodeId } : {}),
  });

  if (opts.json) printJson(file, chain, result, index, zoom);
  else printText(file, chain, result, index, zoom);
  return 0;
}
