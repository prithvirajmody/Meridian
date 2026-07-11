#!/usr/bin/env node
/**
 * meridian — headless driver for the Universal Semantic Graph (Phases 0–3).
 * Everything here is presentation over graph-core/graph-store/abstraction's
 * pure functions plus plugin-host orchestration; no semantic computation and
 * no domain knowledge lives in the CLI (composition root, §20).
 */
import { watch as fsWatch } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import {
  buildContainmentIndex,
  containmentPathOf,
  decode,
  encodePretty,
  stats,
  type GraphSpace,
  type Issue,
  type SemanticEdge,
  type SemanticGraph,
  type SemanticNode,
  type SourceRef,
  type SpaceStats,
} from '@meridian/graph-core';
import { cmdCut } from './cut.js';
import { cmdIngest, cmdPlugins } from './ingest.js';
import { cmdLayout } from './layout.js';
import {
  createStore,
  decodeDelta,
  decodeDeltaInput,
  deltaToWire,
  diffSpaces,
  formatVersion,
  invertDelta,
  type ChangeSet,
  type GraphOp,
  type GraphStore,
  type StoreIssue,
} from '@meridian/graph-store';

/** Producer stamped into documents this CLI writes (`mutate --out`). */
const PRODUCER = { name: '@meridian/cli', version: '0.1.0' };

const HELP = `meridian — headless driver for the Universal Semantic Graph (Phases 0–3)

Usage:
  meridian validate <file> [--json]          decode + validate a GraphDocument
  meridian stats <file> [--json]             statistics for a valid document
  meridian inspect <file> <nodeId> [--json]  one node: kind, attrs, provenance,
                                             containment path, detail, edges
  meridian mutate <file> --script <ops.json> [--out <file>]
                  [--emit-delta <file>] [--json]
                                             apply an op-delta script atomically;
                                             optionally write the resulting
                                             document and the completed
                                             (invertible) delta
  meridian invert <delta.json>               print the inverse of a completed
                                             delta (undo as data)
  meridian watch <file> [--apply <ops.json>[,<ops.json>…]] [--json]
                                             stream committed change events;
                                             with --apply, replay scripts and
                                             exit — without, follow the file
                                             and apply semantic diffs live
  meridian cut <file> (--level <N> | --zoom <z>) [--focus <id>] [--json]
                                             resolve the visible cut of a
                                             GraphDocument at a base level
                                             (--level N, 0 = coarsest) or zoom
                                             scalar (--zoom z ∈ [0,1], 1 =
                                             finest): the covering node set plus
                                             induced (aggregated) edges. --focus
                                             is recorded in the cut trace
  meridian layout <file> --svg <out.svg> [--provider <id>]
                  [--level <N> | --zoom <z>] [--json]
                                             lay out the visible cut of a
                                             GraphDocument (default --level 0,
                                             the coarsest) with a deterministic
                                             provider (grid | tree; default
                                             grid) and write a normalized SVG
                                             snapshot
  meridian ingest <source> [--adapter <domain>] [--out <file>] [--json]
                                             run a domain adapter over a source
                                             file: sniff arbitration (or forced
                                             --adapter), atomic ingest, IR gate
                                             with the registered vocabulary;
                                             --out writes the graph document
  meridian plugins list [--json]             registered plugins: versions,
                                             capabilities, vocabulary

Exit codes: 0 ok · 1 invalid input or rejected delta · 2 usage or I/O error
`;

function out(line: string): void {
  process.stdout.write(line + '\n');
}

function usageError(message: string): never {
  process.stderr.write(message + '\n\n' + HELP);
  process.exit(2);
}

async function readDocument(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (e) {
    process.stderr.write(`cannot read ${file}: ${(e as Error).message}\n`);
    process.exit(2);
  }
}

function formatIssue(issue: Issue): string {
  const location = issue.path !== undefined ? `at ${issue.path}: ` : '';
  return `[${issue.code}] ${location}${issue.message}`;
}

function issueBlock(title: string, issues: Issue[]): string[] {
  if (issues.length === 0) return [];
  return [`  ${title} (${issues.length}):`, ...issues.map((i) => `    ${formatIssue(i)}`)];
}

function formatProvenance(p: SourceRef): string {
  let s = p.origin;
  if (p.uri !== undefined) s += ` ${p.uri}`;
  if (p.span !== undefined) s += ` [${p.span[0]},${p.span[1]}]`;
  if (p.model !== undefined) s += ` model=${p.model}`;
  if (p.confidence !== undefined) s += ` confidence=${p.confidence}`;
  return s;
}

function summaryLine(s: SpaceStats): string {
  return `  graphs ${s.graphs} · nodes ${s.nodes} · edges ${s.edges} · roots ${s.roots} · max depth ${s.maxDepth}`;
}

// ------------------------------------------------------------------ validate

function cmdValidate(file: string, text: string, json: boolean): number {
  const result = decode(text);
  if (json) {
    out(
      JSON.stringify(
        {
          file,
          ok: result.ok,
          stats: result.ok ? stats(result.space) : null,
          errors: result.ok ? [] : result.errors,
          warnings: result.warnings,
        },
        null,
        2,
      ),
    );
    return result.ok ? 0 : 1;
  }
  if (result.ok) {
    out(`OK ${file}`);
    out(summaryLine(stats(result.space)));
    for (const line of issueBlock('warnings', result.warnings)) out(line);
    return 0;
  }
  out(`INVALID ${file}`);
  for (const line of issueBlock('errors', result.errors)) out(line);
  for (const line of issueBlock('warnings', result.warnings)) out(line);
  return 1;
}

// --------------------------------------------------------------------- stats

function requireValid(file: string, text: string): GraphSpace {
  const result = decode(text);
  if (!result.ok) {
    out(`INVALID ${file}`);
    for (const line of issueBlock('errors', result.errors)) out(line);
    process.exit(1);
  }
  return result.space;
}

function cmdStats(file: string, text: string, json: boolean): number {
  const space = requireValid(file, text);
  const s = stats(space);
  if (json) {
    out(JSON.stringify({ file, stats: s }, null, 2));
    return 0;
  }
  out(file);
  out(`  graphs             ${s.graphs}`);
  out(`  nodes              ${s.nodes}`);
  out(`  edges              ${s.edges}`);
  out(`  roots              ${s.roots}`);
  out(`  max depth          ${s.maxDepth}`);
  out(`  nodes with detail  ${s.nodesWithDetail}`);
  const histogram = (title: string, counts: Readonly<Record<string, number>>) => {
    const entries = Object.entries(counts);
    if (entries.length === 0) return;
    out(`  ${title}:`);
    const width = Math.max(...entries.map(([k]) => k.length));
    for (const [kind, count] of entries) out(`    ${kind.padEnd(width)}  ${count}`);
  };
  histogram('nodes by kind', s.nodesByKind);
  histogram('edges by kind', s.edgesByKind);
  return 0;
}

// ------------------------------------------------------------------- inspect

interface FoundNode {
  graph: SemanticGraph;
  node: SemanticNode;
}

function findNode(space: GraphSpace, nodeId: string): FoundNode | undefined {
  for (const graph of space.graphs.values()) {
    for (const node of graph.nodes.values()) {
      if (node.id === nodeId) return { graph, node };
    }
  }
  return undefined;
}

function edgeEnd(graph: SemanticGraph, id: string): string {
  const label = graph.nodes.get(id as never)?.label;
  return label !== undefined ? `${id} "${label}"` : id;
}

function cmdInspect(file: string, text: string, nodeId: string, json: boolean): number {
  const space = requireValid(file, text);
  const found = findNode(space, nodeId);
  if (!found) {
    process.stderr.write(`node "${nodeId}" not found in ${file}\n`);
    return 1;
  }
  const { graph, node } = found;
  const index = buildContainmentIndex(space);
  const path = containmentPathOf(space, graph.id, index).map((gid) => {
    const g = space.graphs.get(gid)!;
    return { graph: String(gid), label: g.meta.label };
  });
  const byId = (a: SemanticEdge, b: SemanticEdge) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const outgoing = [...graph.edges.values()].filter((e) => e.src === node.id).sort(byId);
  const incoming = [...graph.edges.values()].filter((e) => e.dst === node.id).sort(byId);
  const detailGraph = node.detail ? space.graphs.get(node.detail.graph) : undefined;

  if (json) {
    out(
      JSON.stringify(
        {
          file,
          node: {
            id: node.id,
            kind: node.kind,
            label: node.label,
            graph: graph.id,
            path,
            attrs: node.attrs,
            provenance: node.provenance,
            detail: detailGraph
              ? {
                  graph: detailGraph.id,
                  label: detailGraph.meta.label,
                  nodes: detailGraph.nodes.size,
                  edges: detailGraph.edges.size,
                }
              : null,
            outgoing: outgoing.map((e) => ({
              id: e.id,
              kind: e.kind,
              dst: e.dst,
              ...(e.weight !== undefined ? { weight: e.weight } : {}),
            })),
            incoming: incoming.map((e) => ({
              id: e.id,
              kind: e.kind,
              src: e.src,
              ...(e.weight !== undefined ? { weight: e.weight } : {}),
            })),
          },
        },
        null,
        2,
      ),
    );
    return 0;
  }

  out(`node ${node.id} — "${node.label}" (${node.kind})`);
  out(`  graph        ${graph.id} "${graph.meta.label}" — depth ${path.length}`);
  out(`  path         ${path.map((p) => `${p.graph} "${p.label}"`).join(' › ')}`);
  out(`  provenance   ${formatProvenance(node.provenance)}`);
  const attrEntries = Object.entries(node.attrs).sort(([a], [b]) => (a < b ? -1 : 1));
  if (attrEntries.length === 0) {
    out('  attrs        (none)');
  } else {
    out('  attrs:');
    for (const [key, value] of attrEntries) out(`    ${key} = ${JSON.stringify(value)}`);
  }
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  out(
    detailGraph
      ? `  detail       ${detailGraph.id} "${detailGraph.meta.label}" — ${count(detailGraph.nodes.size, 'node')}, ${count(detailGraph.edges.size, 'edge')}`
      : '  detail       (none)',
  );
  out(`  edges out (${outgoing.length}):`);
  for (const e of outgoing) {
    out(`    [${e.kind}] → ${edgeEnd(graph, e.dst)}${e.weight !== undefined ? ` (weight ${e.weight})` : ''}`);
  }
  out(`  edges in (${incoming.length}):`);
  for (const e of incoming) {
    out(`    [${e.kind}] ← ${edgeEnd(graph, e.src)}${e.weight !== undefined ? ` (weight ${e.weight})` : ''}`);
  }
  return 0;
}

// ------------------------------------------------------------------- mutate

function formatStoreIssue(issue: StoreIssue): string {
  const opIdx = issue.opIndex !== undefined ? `ops[${issue.opIndex}] ` : '';
  const at = issue.path !== undefined ? `at ${issue.path}: ` : '';
  return `[${issue.code}] ${opIdx}${at}${issue.message}`;
}

function storeIssueBlock(title: string, issues: readonly StoreIssue[]): string[] {
  return [`  ${title} (${issues.length}):`, ...issues.map((i) => `    ${formatStoreIssue(i)}`)];
}

/** "node:add 3, node:attr 2, …" — counts by op type, name-sorted (I6). */
function opCounts(ops: readonly GraphOp[]): string {
  const counts = new Map<string, number>();
  for (const op of ops) counts.set(op.t, (counts.get(op.t) ?? 0) + 1);
  return [...counts.keys()]
    .sort()
    .map((t) => `${t} ${counts.get(t)}`)
    .join(', ');
}

function attrValueText(v: unknown): string {
  return v === undefined ? '(unset)' : JSON.stringify(v);
}

function describeOp(op: GraphOp): string {
  switch (op.t) {
    case 'graph:add':
      return `graph:add ${op.graph} "${op.meta.label}"`;
    case 'graph:remove':
      return `graph:remove ${op.graph}`;
    case 'graph:meta':
      return `graph:meta ${op.graph} "${op.prev.label}" → "${op.next.label}"`;
    case 'node:add':
      return `node:add ${op.graph} ${op.node.id} "${op.node.label}"`;
    case 'node:remove':
      return `node:remove ${op.graph} ${op.id}`;
    case 'node:attr':
      return `node:attr ${op.graph} ${op.id} ${op.key} ${attrValueText(op.prev)} → ${attrValueText(op.next)}`;
    case 'node:detail':
      return `node:detail ${op.graph} ${op.id} ${op.prev?.graph ?? '(none)'} → ${op.next?.graph ?? '(none)'}`;
    case 'edge:add':
      return `edge:add ${op.graph} ${op.edge.id} ${op.edge.src} → ${op.edge.dst} [${op.edge.kind}]`;
    case 'edge:remove':
      return `edge:remove ${op.graph} ${op.id}`;
  }
}

const OP_LINE_CAP = 20;

function opLines(ops: readonly GraphOp[]): string[] {
  const shown = ops.slice(0, OP_LINE_CAP);
  const lines = shown.map((op, i) => `    [${i}] ${describeOp(op)}`);
  if (ops.length > OP_LINE_CAP) lines.push(`    … ${ops.length - OP_LINE_CAP} more ops`);
  return lines;
}

function sortedIds(set: ReadonlySet<string>): string[] {
  return [...set].map(String).sort();
}

function changeSetJson(change: ChangeSet): Record<string, unknown> {
  return {
    from: change.fromVersion,
    to: change.toVersion,
    delta: deltaToWire({ baseVersion: change.fromVersion, origin: change.origin, ops: change.ops }),
    touched: { graphs: sortedIds(change.touched.graphs), nodes: sortedIds(change.touched.nodes) },
  };
}

function changeSetText(change: ChangeSet): string[] {
  return [
    `${formatVersion(change.fromVersion)} → ${formatVersion(change.toVersion)} · ${change.origin.actor} · ` +
      `${change.ops.length} op${change.ops.length === 1 ? '' : 's'} (${opCounts(change.ops)}) · ` +
      `touched ${change.touched.graphs.size} graph${change.touched.graphs.size === 1 ? '' : 's'}, ` +
      `${change.touched.nodes.size} node${change.touched.nodes.size === 1 ? '' : 's'}`,
    ...opLines(change.ops),
  ];
}

async function readScript(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (e) {
    process.stderr.write(`cannot read ${file}: ${(e as Error).message}\n`);
    process.exit(2);
  }
}

async function cmdMutate(
  file: string,
  text: string,
  scriptPath: string,
  opts: { json: boolean; out?: string; emitDelta?: string },
): Promise<number> {
  const space = requireValid(file, text);
  const script = decodeDeltaInput(await readScript(scriptPath));
  if (!script.ok) {
    out(`REJECTED ${scriptPath} (script does not parse)`);
    for (const line of storeIssueBlock('errors', script.errors)) out(line);
    return 1;
  }
  const store = createStore(space);
  const fromVersion = store.version();
  const result = store.apply(script.delta);
  if (!result.ok) {
    out(`REJECTED ${scriptPath}`);
    for (const line of storeIssueBlock('errors', result.errors)) out(line);
    out(`  nothing applied — deltas are atomic (${file} unchanged)`);
    return 1;
  }
  const written: string[] = [];
  if (opts.out !== undefined) {
    await writeFile(opts.out, encodePretty(store.snapshot(), { producer: PRODUCER }), 'utf8');
    written.push(opts.out);
  }
  if (opts.emitDelta !== undefined) {
    await writeFile(opts.emitDelta, JSON.stringify(deltaToWire(result.delta), null, 2) + '\n', 'utf8');
    written.push(opts.emitDelta);
  }
  if (opts.json) {
    out(
      JSON.stringify(
        {
          file,
          script: scriptPath,
          ok: true,
          from: fromVersion,
          to: store.version(),
          delta: deltaToWire(result.delta),
          touched: {
            graphs: sortedIds(result.changes.touched.graphs),
            nodes: sortedIds(result.changes.touched.nodes),
          },
          stats: stats(store.snapshot()),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  out(`OK ${file}`);
  for (const line of changeSetText(result.changes).map((l) => `  ${l}`)) out(line);
  out(`  now: ${summaryLine(stats(store.snapshot())).trim()}`);
  for (const w of written) out(`  wrote ${w}`);
  return 0;
}

// ------------------------------------------------------------------- invert

async function cmdInvert(deltaPath: string): Promise<number> {
  const decoded = decodeDelta(await readScript(deltaPath));
  if (!decoded.ok) {
    out(`REJECTED ${deltaPath} (not a completed delta)`);
    for (const line of storeIssueBlock('errors', decoded.errors)) out(line);
    return 1;
  }
  // Emit the portable form: no version stamp (stamps are per-store-session,
  // ADR-0007) — the ops' prev assertions carry cross-session safety.
  const inverse = invertDelta(decoded.delta);
  out(JSON.stringify(deltaToWire({ origin: inverse.origin, ops: inverse.ops }), null, 2));
  return 0;
}

// -------------------------------------------------------------------- watch

function printChange(change: ChangeSet, json: boolean): void {
  if (json) {
    out(JSON.stringify(changeSetJson(change)));
    return;
  }
  for (const line of changeSetText(change)) out(line);
}

const microtasksFlushed = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function watchApply(store: GraphStore, scripts: string[]): Promise<number> {
  let rejected = 0;
  for (const scriptPath of scripts) {
    const script = decodeDeltaInput(await readScript(scriptPath));
    if (!script.ok) {
      await microtasksFlushed(); // keep event output ordered ahead of errors
      out(`REJECTED ${scriptPath} (script does not parse)`);
      for (const line of storeIssueBlock('errors', script.errors)) out(line);
      rejected++;
      continue;
    }
    const result = store.apply(script.delta);
    if (!result.ok) {
      await microtasksFlushed();
      out(`REJECTED ${scriptPath}`);
      for (const line of storeIssueBlock('errors', result.errors)) out(line);
      rejected++;
    }
  }
  await microtasksFlushed();
  out(
    `done: ${formatVersion(store.version())} · ${scripts.length - rejected} applied, ${rejected} rejected`,
  );
  return rejected > 0 ? 1 : 0;
}

async function cmdWatch(
  file: string,
  text: string,
  opts: { json: boolean; apply?: string },
): Promise<number> {
  const space = requireValid(file, text);
  const store = createStore(space, {
    onListenerError: (e) => process.stderr.write(`listener error: ${String(e)}\n`),
  });
  store.subscribe((change) => printChange(change, opts.json));
  const s = stats(store.snapshot());
  out(`watching ${file} — ${formatVersion(store.version())} · ${s.graphs} graphs · ${s.nodes} nodes · ${s.edges} edges`);

  if (opts.apply !== undefined) {
    return watchApply(store, opts.apply.split(',').filter((p) => p.length > 0));
  }

  // Live mode: follow the file; each save becomes a semantic diff-delta.
  let timer: NodeJS.Timeout | undefined;
  const onChange = async (): Promise<void> => {
    let next;
    try {
      next = decode(await readFile(file, 'utf8'));
    } catch (e) {
      out(`${file}: unreadable (${(e as Error).message}) — still watching`);
      return;
    }
    if (!next.ok) {
      out(`${file}: INVALID (${next.errors.length} errors) — still watching`);
      return;
    }
    const delta = diffSpaces(store.snapshot(), next.space, { actor: 'watch' });
    if (delta.ops.length === 0) {
      out(`${file}: changed — no semantic difference`);
      return;
    }
    const result = store.apply(delta);
    if (!result.ok) {
      out(`${file}: diff delta rejected — still watching`);
      for (const line of storeIssueBlock('errors', result.errors)) out(line);
    }
  };
  fsWatch(file, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void onChange(), 60);
  });
  await new Promise<void>((resolve) => process.once('SIGINT', () => resolve()));
  return 0;
}

// ---------------------------------------------------------------------- main

const VALUE_FLAGS = new Set(['--script', '--out', '--emit-delta', '--apply', '--adapter', '--level', '--zoom', '--focus', '--svg', '--provider']);

interface Cli {
  readonly positional: string[];
  readonly json: boolean;
  readonly values: Map<string, string>;
}

function parseCli(args: string[]): Cli {
  const positional: string[] = [];
  const values = new Map<string, string>();
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') {
      json = true;
    } else if (VALUE_FLAGS.has(arg)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) usageError(`${arg}: missing value`);
      values.set(arg, value);
      i++;
    } else if (arg.startsWith('--')) {
      usageError(`unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { positional, json, values };
}

function allowFlags(cli: Cli, command: string, allowed: string[]): void {
  for (const flag of cli.values.keys()) {
    if (!allowed.includes(flag)) usageError(`${command}: unexpected flag ${flag}`);
  }
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const [command, file, extra] = cli.positional;
  if (command === undefined || command === 'help' || command === '--help') {
    process.stderr.write(HELP);
    process.exit(command === undefined ? 2 : 0);
  }
  if (file === undefined) usageError(`${command}: missing <file> argument`);

  switch (command) {
    case 'validate': {
      allowFlags(cli, command, []);
      process.exit(cmdValidate(file, await readDocument(file), cli.json));
      break;
    }
    case 'stats': {
      allowFlags(cli, command, []);
      process.exit(cmdStats(file, await readDocument(file), cli.json));
      break;
    }
    case 'inspect': {
      allowFlags(cli, command, []);
      if (extra === undefined) usageError('inspect: missing <nodeId> argument');
      process.exit(cmdInspect(file, await readDocument(file), extra, cli.json));
      break;
    }
    case 'mutate': {
      allowFlags(cli, command, ['--script', '--out', '--emit-delta']);
      const script = cli.values.get('--script');
      if (script === undefined) usageError('mutate: missing --script <ops.json>');
      process.exit(
        await cmdMutate(file, await readDocument(file), script, {
          json: cli.json,
          ...(cli.values.has('--out') ? { out: cli.values.get('--out')! } : {}),
          ...(cli.values.has('--emit-delta') ? { emitDelta: cli.values.get('--emit-delta')! } : {}),
        }),
      );
      break;
    }
    case 'invert': {
      allowFlags(cli, command, []);
      process.exit(await cmdInvert(file));
      break;
    }
    case 'watch': {
      allowFlags(cli, command, ['--apply']);
      process.exit(
        await cmdWatch(file, await readDocument(file), {
          json: cli.json,
          ...(cli.values.has('--apply') ? { apply: cli.values.get('--apply')! } : {}),
        }),
      );
      break;
    }
    case 'cut': {
      allowFlags(cli, command, ['--level', '--zoom', '--focus']);
      const hasLevel = cli.values.has('--level');
      const hasZoom = cli.values.has('--zoom');
      if (hasLevel === hasZoom) usageError('cut: give exactly one of --level <N> or --zoom <z>');
      let level: number | undefined;
      let zoom: number | undefined;
      if (hasLevel) {
        const raw = cli.values.get('--level')!;
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0) usageError(`cut: --level must be a non-negative integer, got "${raw}"`);
        level = n;
      } else {
        const raw = cli.values.get('--zoom')!;
        const z = Number(raw);
        if (!Number.isFinite(z) || z < 0 || z > 1) usageError(`cut: --zoom must be a number in [0,1], got "${raw}"`);
        zoom = z;
      }
      process.exit(
        await cmdCut(file, {
          json: cli.json,
          ...(level !== undefined ? { level } : {}),
          ...(zoom !== undefined ? { zoom } : {}),
          ...(cli.values.has('--focus') ? { focus: cli.values.get('--focus')! } : {}),
        }),
      );
      break;
    }
    case 'layout': {
      allowFlags(cli, command, ['--svg', '--provider', '--level', '--zoom']);
      const svg = cli.values.get('--svg');
      if (svg === undefined) usageError('layout: missing --svg <out.svg>');
      if (cli.values.has('--level') && cli.values.has('--zoom')) {
        usageError('layout: give at most one of --level <N> or --zoom <z>');
      }
      let level: number | undefined;
      let zoom: number | undefined;
      if (cli.values.has('--level')) {
        const raw = cli.values.get('--level')!;
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0) usageError(`layout: --level must be a non-negative integer, got "${raw}"`);
        level = n;
      } else if (cli.values.has('--zoom')) {
        const raw = cli.values.get('--zoom')!;
        const z = Number(raw);
        if (!Number.isFinite(z) || z < 0 || z > 1) usageError(`layout: --zoom must be a number in [0,1], got "${raw}"`);
        zoom = z;
      }
      process.exit(
        await cmdLayout(file, {
          json: cli.json,
          svg,
          provider: cli.values.get('--provider') ?? 'grid',
          ...(level !== undefined ? { level } : {}),
          ...(zoom !== undefined ? { zoom } : {}),
        }),
      );
      break;
    }
    case 'ingest': {
      allowFlags(cli, command, ['--adapter', '--out']);
      process.exit(
        await cmdIngest(file, {
          json: cli.json,
          ...(cli.values.has('--adapter') ? { adapter: cli.values.get('--adapter')! } : {}),
          ...(cli.values.has('--out') ? { out: cli.values.get('--out')! } : {}),
        }),
      );
      break;
    }
    case 'plugins': {
      allowFlags(cli, command, []);
      if (file !== 'list') usageError(`plugins: unknown subcommand "${file}" (expected: list)`);
      process.exit(cmdPlugins(cli.json));
      break;
    }
    default:
      usageError(`unknown command: ${command}`);
  }
}

void main();
