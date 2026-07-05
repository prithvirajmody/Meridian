#!/usr/bin/env node
/**
 * meridian — headless driver for the Universal Semantic Graph (Phase 0).
 * Everything here is presentation over graph-core's pure functions; no
 * semantic computation lives in the CLI.
 */
import { readFile } from 'node:fs/promises';
import {
  buildContainmentIndex,
  containmentPathOf,
  decode,
  stats,
  type GraphSpace,
  type Issue,
  type SemanticEdge,
  type SemanticGraph,
  type SemanticNode,
  type SourceRef,
  type SpaceStats,
} from '@meridian/graph-core';

const HELP = `meridian — headless driver for the Universal Semantic Graph (Phase 0)

Usage:
  meridian validate <file> [--json]          decode + validate a GraphDocument
  meridian stats <file> [--json]             statistics for a valid document
  meridian inspect <file> <nodeId> [--json]  one node: kind, attrs, provenance,
                                             containment path, detail, edges

Exit codes: 0 ok · 1 invalid document or node not found · 2 usage or I/O error
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

// ---------------------------------------------------------------------- main

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const positional = args.filter((a) => a !== '--json');
  const unknownFlags = positional.filter((a) => a.startsWith('--'));
  if (unknownFlags.length > 0) usageError(`unknown flag: ${unknownFlags[0]}`);

  const [command, file, extra] = positional;
  if (command === undefined || command === 'help' || command === '--help') {
    process.stderr.write(HELP);
    process.exit(command === undefined ? 2 : 0);
  }
  if (file === undefined) usageError(`${command}: missing <file> argument`);

  switch (command) {
    case 'validate': {
      process.exit(cmdValidate(file, await readDocument(file), json));
      break;
    }
    case 'stats': {
      process.exit(cmdStats(file, await readDocument(file), json));
      break;
    }
    case 'inspect': {
      if (extra === undefined) usageError('inspect: missing <nodeId> argument');
      process.exit(cmdInspect(file, await readDocument(file), extra, json));
      break;
    }
    default:
      usageError(`unknown command: ${command}`);
  }
}

void main();
