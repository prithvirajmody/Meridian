/** Public deterministic structural diff producer (ADR-0046). */
import { readFile } from 'node:fs/promises';
import {
  CURRENT_FORMAT_VERSION,
  decode,
  encodeCanonical,
  type DocumentSource,
  type GraphSpace,
} from '@meridian/graph-core';
import { applyDelta, diffSpaces, type GraphOp } from '@meridian/graph-store';
import {
  bridgeDiffArtifactSchema,
  bridgeStructuralDeltaSchema,
  type BridgeDiffArtifactV1,
  type BridgeDiffSummaryV1,
  type BridgeKindCountsV1,
  type BridgeStructuralDeltaV1,
} from './bridge-contract.js';
import {
  GRAPH_STORE_PACKAGE,
  GRAPH_STORE_VERSION,
  MERIDIAN_VERSION,
  canonicalBridgeJson,
  resolveBridgeOutputPair,
  sha256Bytes,
  utf8Size,
  writeBridgeOutputPair,
} from './bridge-artifacts.js';
import { stderrLine, stdoutLine } from './io.js';

interface LoadedDocument {
  readonly bytes: Uint8Array;
  readonly space: GraphSpace;
  readonly source?: DocumentSource;
}

export interface DiffOptions {
  readonly json: boolean;
  readonly deltaOut?: string;
  readonly descriptor?: string;
}

function issueText(result: Extract<ReturnType<typeof decode>, { readonly ok: false }>): string {
  const first = result.errors[0];
  if (first === undefined) return 'unknown graph document error';
  const at = first.path !== undefined ? ` at ${first.path}` : '';
  return `[${first.code}]${at}: ${first.message}`;
}

async function loadDocument(path: string): Promise<LoadedDocument> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error(`invalid ${path}: UTF-8 BOM is not permitted`);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`invalid ${path}: document is not UTF-8`);
  }
  const result = decode(text);
  if (!result.ok) throw new Error(`invalid ${path}: ${issueText(result)}`);
  return {
    bytes,
    space: result.space,
    ...(result.source !== undefined ? { source: result.source } : {}),
  };
}

function detailOwners(space: GraphSpace): Map<string, string> {
  const owners = new Map<string, string>();
  for (const graph of space.graphs.values()) {
    for (const node of graph.nodes.values()) {
      if (node.detail !== undefined) owners.set(node.detail.graph, `${graph.id}\0${node.id}`);
    }
  }
  return owners;
}

function incrementKind(
  counts: Map<string, { added: number; removed: number }>,
  kind: string,
  field: 'added' | 'removed',
): void {
  const current = counts.get(kind) ?? { added: 0, removed: 0 };
  current[field] += 1;
  counts.set(kind, current);
}

export function summarizeStructuralDiff(
  ops: readonly GraphOp[],
  from: GraphSpace,
  to: GraphSpace,
): BridgeDiffSummaryV1 {
  let nodesAdded = 0;
  let nodesRemoved = 0;
  let edgesAdded = 0;
  let edgesRemoved = 0;
  const kinds = new Map<string, { added: number; removed: number }>();
  for (const op of ops) {
    switch (op.t) {
      case 'node:add':
        nodesAdded++;
        incrementKind(kinds, op.node.kind, 'added');
        break;
      case 'node:remove':
        nodesRemoved++;
        incrementKind(kinds, op.prev.kind, 'removed');
        break;
      case 'edge:add':
        edgesAdded++;
        incrementKind(kinds, op.edge.kind, 'added');
        break;
      case 'edge:remove':
        edgesRemoved++;
        incrementKind(kinds, op.prev.kind, 'removed');
        break;
      default:
        break;
    }
  }

  const before = detailOwners(from);
  const after = detailOwners(to);
  let nodesMoved = 0;
  for (const [child, owner] of before) {
    const nextOwner = after.get(child);
    if (nextOwner !== undefined && nextOwner !== owner) nodesMoved++;
  }

  const byKind: Record<string, BridgeKindCountsV1> = {};
  for (const [kind, counts] of [...kinds].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    byKind[kind] = counts;
  }
  return {
    nodes_added: nodesAdded,
    nodes_removed: nodesRemoved,
    nodes_moved: nodesMoved,
    edges_added: edgesAdded,
    edges_removed: edgesRemoved,
    by_kind: byKind,
  };
}

function calculateDiff(
  from: LoadedDocument,
  to: LoadedDocument,
): { ops: readonly GraphOp[]; summary: BridgeDiffSummaryV1; different: boolean } {
  const proposed = diffSpaces(from.space, to.space, { actor: 'meridian:diff' });
  let completed: readonly GraphOp[] = [];
  let replayed = from.space;
  if (proposed.ops.length > 0) {
    const result = applyDelta(from.space, proposed);
    if (!result.ok) {
      throw new Error(`diff replay failed: ${result.errors[0]?.message ?? 'unknown op failure'}`);
    }
    completed = result.ops;
    replayed = result.space;
  }
  if (encodeCanonical(replayed) !== encodeCanonical(to.space)) {
    throw new Error('diff replay did not reproduce the target graph space');
  }
  return {
    ops: completed,
    summary: summarizeStructuralDiff(completed, from.space, to.space),
    different: completed.length > 0,
  };
}

function buildStructuralDelta(
  from: LoadedDocument,
  to: LoadedDocument,
  ops: readonly GraphOp[],
): BridgeStructuralDeltaV1 {
  if (from.source === undefined || to.source === undefined) {
    throw new Error('artifact mode requires source provenance in both graph documents');
  }
  return bridgeStructuralDeltaSchema.parse({
    schema_version: 1,
    kind: 'meridian-structural-delta',
    from: { repo: from.source.repo, ref: from.source.ref },
    to: { repo: to.source.repo, ref: to.source.ref },
    origin: { actor: 'meridian:diff' },
    ops,
  });
}

function buildDescriptor(
  from: LoadedDocument,
  to: LoadedDocument,
  deltaReference: string,
  deltaBytes: string,
  summary: BridgeDiffSummaryV1,
): BridgeDiffArtifactV1 {
  if (from.source === undefined || to.source === undefined) {
    throw new Error('artifact mode requires source provenance in both graph documents');
  }
  return bridgeDiffArtifactSchema.parse({
    schema_version: 1,
    kind: 'meridian-diff',
    from: {
      repo: from.source.repo,
      ref: from.source.ref,
      document_sha256: sha256Bytes(from.bytes),
      document_size_bytes: from.bytes.byteLength,
      graph_format_version: CURRENT_FORMAT_VERSION,
    },
    to: {
      repo: to.source.repo,
      ref: to.source.ref,
      document_sha256: sha256Bytes(to.bytes),
      document_size_bytes: to.bytes.byteLength,
      graph_format_version: CURRENT_FORMAT_VERSION,
    },
    produced_by: {
      meridian_version: MERIDIAN_VERSION,
      diff_engine: GRAPH_STORE_PACKAGE,
      diff_engine_version: GRAPH_STORE_VERSION,
    },
    summary,
    delta: deltaReference,
    delta_sha256: sha256Bytes(new TextEncoder().encode(deltaBytes)),
    delta_size_bytes: utf8Size(deltaBytes),
    delta_format_version: 1,
  });
}

function printHuman(
  fromPath: string,
  toPath: string,
  summary: BridgeDiffSummaryV1,
  different: boolean,
): void {
  stdoutLine(`${different ? 'DIFFERENT' : 'IDENTICAL'} ${fromPath} → ${toPath}`);
  stdoutLine(
    `  nodes +${summary.nodes_added} -${summary.nodes_removed} moved ${summary.nodes_moved} · ` +
      `edges +${summary.edges_added} -${summary.edges_removed}`,
  );
  for (const [kind, counts] of Object.entries(summary.by_kind)) {
    stdoutLine(`  ${kind} +${counts.added} -${counts.removed}`);
  }
}

export async function cmdDiff(
  fromPath: string,
  toPath: string,
  options: DiffOptions,
): Promise<number> {
  try {
    const from = await loadDocument(fromPath);
    const to = await loadDocument(toPath);
    const result = calculateDiff(from, to);
    const hasArtifactMode = options.deltaOut !== undefined || options.descriptor !== undefined;
    if (hasArtifactMode) {
      if (options.deltaOut === undefined || options.descriptor === undefined) {
        throw new Error('artifact mode requires both --delta-out and --descriptor');
      }
      if (from.source === undefined || to.source === undefined) {
        throw new Error('artifact mode requires source provenance in both graph documents');
      }
      const pair = resolveBridgeOutputPair(options.deltaOut, options.descriptor, [
        fromPath,
        toPath,
      ]);
      const deltaBytes = canonicalBridgeJson(buildStructuralDelta(from, to, result.ops));
      const descriptor = buildDescriptor(
        from,
        to,
        pair.artifactReference,
        deltaBytes,
        result.summary,
      );
      await writeBridgeOutputPair(pair, deltaBytes, canonicalBridgeJson(descriptor));
    }

    if (options.json) {
      stdoutLine(
        JSON.stringify(
          {
            different: result.different,
            ...(from.source !== undefined && to.source !== undefined
              ? {
                  from: { repo: from.source.repo, ref: from.source.ref },
                  to: { repo: to.source.repo, ref: to.source.ref },
                }
              : {}),
            summary: result.summary,
          },
          null,
          2,
        ),
      );
    } else {
      printHuman(fromPath, toPath, result.summary, result.different);
      if (hasArtifactMode) {
        stdoutLine(`  wrote ${options.deltaOut}`);
        stdoutLine(`  wrote ${options.descriptor}`);
      }
    }
    return result.different ? 1 : 0;
  } catch (error) {
    stderrLine(`diff: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}
