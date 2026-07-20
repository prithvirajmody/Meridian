/** End-to-end bridge-v1 producer acceptance for ADR-0045/0046. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, encodeCanonical } from '@meridian/graph-core';
import { applyDelta, decodeDeltaInput } from '@meridian/graph-store';
import { afterAll, describe, expect, it } from 'vitest';
import {
  bridgeDiffArtifactSchema,
  bridgeGraphArtifactSchema,
  bridgeStructuralDeltaSchema,
  type BridgeDiffSummaryV1,
} from '../src/bridge-contract.js';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const cli = resolve(repoRoot, 'apps/cli/dist/main.js');
const markdown = resolve(repoRoot, 'fixtures/corpora/markdown/basic.md');
const bridgeFixtures = resolve(repoRoot, 'contracts/bridge-v1/fixtures');
const fromDocument = resolve(bridgeFixtures, 'bundle/from.graph.json');
const toDocument = resolve(bridgeFixtures, 'bundle/to.graph.json');
const expectedDiff = JSON.parse(
  readFileSync(resolve(bridgeFixtures, 'valid-diff-artifact.json'), 'utf8'),
) as { summary: BridgeDiffSummaryV1 };
const REPO = 'https://example.test/acme/widgets.git';
const REF = 'c'.repeat(40);

function run(args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    code: result.status,
  };
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const scratch = mkdtempSync(join(tmpdir(), 'meridian-bridge-producers-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function pinnedIngest(directory: string, ref = REF) {
  mkdirSync(directory, { recursive: true });
  const graph = join(directory, 'graph.json');
  const descriptor = join(directory, 'graph-artifact.json');
  const result = run([
    'ingest',
    markdown,
    '--repo',
    REPO,
    '--ref',
    ref,
    '--out',
    graph,
    '--descriptor',
    descriptor,
  ]);
  return { result, graph, descriptor };
}

function diffArtifacts(directory: string, from = fromDocument, to = toDocument) {
  mkdirSync(directory, { recursive: true });
  const delta = join(directory, 'delta.json');
  const descriptor = join(directory, 'diff-artifact.json');
  const result = run([
    'diff',
    from,
    to,
    '--delta-out',
    delta,
    '--descriptor',
    descriptor,
    '--json',
  ]);
  return { result, delta, descriptor };
}

describe('pinned ingest bridge producer (ADR-0045)', () => {
  it('writes canonical pinned graph bytes and an exactly correlated descriptor', () => {
    const produced = pinnedIngest(join(scratch, 'ingest-one'));
    expect(produced.result.code).toBe(0);
    expect(produced.result.stderr).toBe('');

    const graphBytes = readFileSync(produced.graph);
    const graphText = graphBytes.toString('utf8');
    expect(graphText.endsWith('\n')).toBe(false);
    expect(JSON.stringify(JSON.parse(graphText))).toBe(graphText);
    const graph = JSON.parse(graphText) as {
      source: {
        repo: string;
        ref: string;
        ingested_by: Record<string, unknown>;
      };
      graphs: Array<{ meta: { domain: string }; nodes: unknown[]; edges: unknown[] }>;
    };
    expect(graph.source.repo).toBe(REPO);
    expect(graph.source.ref).toBe(REF);

    const descriptor = bridgeGraphArtifactSchema.parse(
      JSON.parse(readFileSync(produced.descriptor, 'utf8')),
    );
    expect(descriptor.document).toBe('graph.json');
    expect(descriptor.target).toEqual({ repo: REPO, ref: REF });
    expect(descriptor.produced_by).toEqual(graph.source.ingested_by);
    expect(descriptor.document_sha256).toBe(sha256(graphBytes));
    expect(descriptor.document_size_bytes).toBe(graphBytes.byteLength);
    expect(descriptor.node_count).toBe(
      graph.graphs.reduce((count, item) => count + item.nodes.length, 0),
    );
    expect(descriptor.edge_count).toBe(
      graph.graphs.reduce((count, item) => count + item.edges.length, 0),
    );
    expect(descriptor.domains).toEqual(
      [...new Set(graph.graphs.map((item) => item.meta.domain))].sort(),
    );
  });

  it('is byte-deterministic and changes both evidence files when the pin changes', () => {
    const first = pinnedIngest(join(scratch, 'ingest-determinism-a'));
    const second = pinnedIngest(join(scratch, 'ingest-determinism-b'));
    expect(first.result.code).toBe(0);
    expect(second.result.code).toBe(0);
    expect(readFileSync(second.graph)).toEqual(readFileSync(first.graph));
    expect(readFileSync(second.descriptor)).toEqual(readFileSync(first.descriptor));

    const changed = pinnedIngest(join(scratch, 'ingest-pin-change'), 'd'.repeat(40));
    expect(changed.result.code).toBe(0);
    expect(readFileSync(changed.graph)).not.toEqual(readFileSync(first.graph));
    expect(readFileSync(changed.descriptor)).not.toEqual(readFileSync(first.descriptor));
  });

  it('preserves the existing unpinned pretty output', () => {
    const graph = join(scratch, 'legacy-pretty.json');
    const result = run(['ingest', markdown, '--out', graph]);
    expect(result.code).toBe(0);
    const text = readFileSync(graph, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).not.toHaveProperty('source');
  });

  it('rejects incomplete pins, bad pins, unsafe relationships, and input overwrite', () => {
    const base = join(scratch, 'ingest-negative');
    mkdirSync(base, { recursive: true });
    const graph = join(base, 'graph.json');
    const descriptor = join(base, 'descriptor.json');
    expect(run(['ingest', markdown, '--repo', REPO, '--ref', REF, '--out', graph]).code).toBe(2);
    expect(
      run([
        'ingest',
        markdown,
        '--repo',
        REPO,
        '--ref',
        'A'.repeat(40),
        '--out',
        graph,
        '--descriptor',
        descriptor,
      ]).code,
    ).toBe(2);
    expect(
      run([
        'ingest',
        markdown,
        '--repo',
        '../relative',
        '--ref',
        REF,
        '--out',
        graph,
        '--descriptor',
        descriptor,
      ]).code,
    ).toBe(2);
    const elsewhere = join(scratch, 'somewhere-else', 'descriptor.json');
    mkdirSync(dirname(elsewhere), { recursive: true });
    expect(
      run([
        'ingest',
        markdown,
        '--repo',
        REPO,
        '--ref',
        REF,
        '--out',
        graph,
        '--descriptor',
        elsewhere,
      ]).code,
    ).toBe(2);

    const input = join(base, 'input.md');
    writeFileSync(input, '# protected\n');
    expect(
      run([
        'ingest',
        input,
        '--repo',
        REPO,
        '--ref',
        REF,
        '--out',
        input,
        '--descriptor',
        descriptor,
      ]).code,
    ).toBe(2);
    expect(readFileSync(input, 'utf8')).toBe('# protected\n');

    const failedPair = join(base, 'failed-pair');
    const nonFileGraph = join(failedPair, 'graph.json');
    const staleDescriptor = join(failedPair, 'descriptor.json');
    mkdirSync(nonFileGraph, { recursive: true });
    writeFileSync(staleDescriptor, 'stale completion marker');
    expect(
      run([
        'ingest',
        markdown,
        '--repo',
        REPO,
        '--ref',
        REF,
        '--out',
        nonFileGraph,
        '--descriptor',
        staleDescriptor,
      ]).code,
    ).toBe(2);
    expect(existsSync(staleDescriptor)).toBe(false);
  });
});

describe('public structural diff bridge producer (ADR-0046)', () => {
  it('returns difference as data and derives the accepted summary', () => {
    const result = run(['diff', fromDocument, toDocument, '--json']);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout) as {
      different: boolean;
      summary: BridgeDiffSummaryV1;
    };
    expect(output.different).toBe(true);
    expect(output.summary).toEqual(expectedDiff.summary);
  });

  it('writes deterministic, schema-valid artifacts and a replayable delta', () => {
    const first = diffArtifacts(join(scratch, 'diff-one'));
    const second = diffArtifacts(join(scratch, 'diff-two'));
    expect(first.result.code).toBe(1);
    expect(first.result.stderr).toBe('');
    expect(second.result.code).toBe(1);
    expect(readFileSync(second.delta)).toEqual(readFileSync(first.delta));
    expect(readFileSync(second.descriptor)).toEqual(readFileSync(first.descriptor));

    const deltaBytes = readFileSync(first.delta);
    const delta = bridgeStructuralDeltaSchema.parse(JSON.parse(deltaBytes.toString('utf8')));
    const descriptor = bridgeDiffArtifactSchema.parse(
      JSON.parse(readFileSync(first.descriptor, 'utf8')),
    );
    expect(descriptor.summary).toEqual(expectedDiff.summary);
    expect(descriptor.delta).toBe('delta.json');
    expect(descriptor.delta_sha256).toBe(sha256(deltaBytes));
    expect(descriptor.delta_size_bytes).toBe(deltaBytes.byteLength);

    const from = decode(readFileSync(fromDocument, 'utf8'));
    const to = decode(readFileSync(toDocument, 'utf8'));
    const parsedDelta = decodeDeltaInput(delta);
    expect(from.ok && to.ok && parsedDelta.ok).toBe(true);
    if (!from.ok || !to.ok || !parsedDelta.ok) return;
    const replayed = applyDelta(from.space, parsedDelta.delta);
    expect(replayed.ok).toBe(true);
    if (replayed.ok) {
      expect(encodeCanonical(replayed.space)).toBe(encodeCanonical(to.space));
    }
  });

  it('returns exit 0 with an empty summary for identical and whitespace-only documents', () => {
    const identical = run(['diff', fromDocument, fromDocument, '--json']);
    expect(identical.code).toBe(0);
    const identicalOutput = JSON.parse(identical.stdout) as {
      different: boolean;
      summary: BridgeDiffSummaryV1;
    };
    expect(identicalOutput.different).toBe(false);
    expect(identicalOutput.summary).toEqual({
      nodes_added: 0,
      nodes_removed: 0,
      nodes_moved: 0,
      edges_added: 0,
      edges_removed: 0,
      by_kind: {},
    });

    const pretty = join(scratch, 'from-pretty.json');
    writeFileSync(pretty, JSON.stringify(JSON.parse(readFileSync(fromDocument, 'utf8')), null, 2) + '\n');
    const whitespace = run(['diff', fromDocument, pretty, '--json']);
    expect(whitespace.code).toBe(0);
    expect((JSON.parse(whitespace.stdout) as { different: boolean }).different).toBe(false);
  });

  it('treats an adapter-ignored source whitespace edit as an empty pinned delta', () => {
    const source = join(scratch, 'whitespace-repo');
    const beforeDir = join(scratch, 'whitespace-before');
    const afterDir = join(scratch, 'whitespace-after');
    mkdirSync(source, { recursive: true });
    mkdirSync(beforeDir, { recursive: true });
    mkdirSync(afterDir, { recursive: true });
    writeFileSync(join(source, 'index.ts'), 'export const stable = 1;\n');
    writeFileSync(join(source, 'notes.txt'), 'ignored notes\n');
    const beforeGraph = join(beforeDir, 'graph.json');
    const beforeDescriptor = join(beforeDir, 'graph-artifact.json');
    expect(
      run([
        'ingest',
        source,
        '--adapter',
        'code',
        '--repo',
        REPO,
        '--ref',
        'e'.repeat(40),
        '--out',
        beforeGraph,
        '--descriptor',
        beforeDescriptor,
      ]).code,
    ).toBe(0);

    writeFileSync(join(source, 'notes.txt'), 'ignored notes  \n\n');
    const afterGraph = join(afterDir, 'graph.json');
    const afterDescriptor = join(afterDir, 'graph-artifact.json');
    expect(
      run([
        'ingest',
        source,
        '--adapter',
        'code',
        '--repo',
        REPO,
        '--ref',
        'f'.repeat(40),
        '--out',
        afterGraph,
        '--descriptor',
        afterDescriptor,
      ]).code,
    ).toBe(0);

    const output = diffArtifacts(join(scratch, 'whitespace-diff'), beforeGraph, afterGraph);
    expect(output.result.code).toBe(0);
    const delta = bridgeStructuralDeltaSchema.parse(
      JSON.parse(readFileSync(output.delta, 'utf8')),
    );
    expect(delta.from.ref).toBe('e'.repeat(40));
    expect(delta.to.ref).toBe('f'.repeat(40));
    expect(delta.ops).toEqual([]);
  });

  it('reports rename as remove/add and keeps attribute-only changes out of add/remove counts', () => {
    const renamedPath = join(scratch, 'renamed.graph.json');
    const renamed = JSON.parse(readFileSync(fromDocument, 'utf8')) as {
      source: { ref: string };
      graphs: Array<{ nodes: Array<{ id: string; label: string; attrs?: Record<string, unknown> }> }>;
    };
    renamed.source.ref = 'd'.repeat(40);
    const oldNode = renamed.graphs.flatMap((graph) => graph.nodes).find((node) => node.id === 'n-old');
    if (oldNode === undefined) throw new Error('fixture node n-old is missing');
    oldNode.label = 'renamed.py';
    writeFileSync(renamedPath, JSON.stringify(renamed));
    const result = run(['diff', fromDocument, renamedPath, '--json']);
    expect(result.code).toBe(1);
    const summary = (JSON.parse(result.stdout) as { summary: BridgeDiffSummaryV1 }).summary;
    expect(summary.nodes_added).toBe(1);
    expect(summary.nodes_removed).toBe(1);
    expect(summary.by_kind['code:module']).toEqual({ added: 1, removed: 1 });
  });

  it('fails closed for invalid documents, unpinned artifact mode, partial flags, and unsafe output', () => {
    const invalid = join(scratch, 'unsupported.graph.json');
    const document = JSON.parse(readFileSync(fromDocument, 'utf8')) as { formatVersion: number };
    document.formatVersion = 2;
    writeFileSync(invalid, JSON.stringify(document));
    const incompatible = run(['diff', fromDocument, invalid, '--json']);
    expect(incompatible.code).toBe(2);
    expect(incompatible.stderr).toContain('unsupported-version');

    const legacy = resolve(repoRoot, 'fixtures/valid/deep-nest.meridian.json');
    const unpinned = diffArtifacts(join(scratch, 'diff-unpinned'), legacy, legacy);
    expect(unpinned.result.code).toBe(2);
    expect(unpinned.result.stderr).toContain('source provenance');

    expect(run(['diff', fromDocument, toDocument, '--delta-out', join(scratch, 'only.json')]).code).toBe(2);
    const left = join(scratch, 'diff-left', 'delta.json');
    const right = join(scratch, 'diff-right', 'descriptor.json');
    mkdirSync(dirname(left), { recursive: true });
    mkdirSync(dirname(right), { recursive: true });
    expect(
      run([
        'diff',
        fromDocument,
        toDocument,
        '--delta-out',
        left,
        '--descriptor',
        right,
      ]).code,
    ).toBe(2);
    expect(
      run([
        'diff',
        fromDocument,
        toDocument,
        '--delta-out',
        fromDocument,
        '--descriptor',
        resolve(dirname(fromDocument), 'no-write-descriptor.json'),
      ]).code,
    ).toBe(2);
  });
});
