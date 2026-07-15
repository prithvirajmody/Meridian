/**
 * Phase 9D acceptance: `meridian ai enrich` builds the argument map over the
 * deterministic paragraph/sentence skeleton — typed
 * `arg:thesis|claim|premise|objection|evidence` nodes anchored to their
 * source paragraphs by `arg:cites` evidence edges, plus the model's
 * `arg:supports|rebuts|assumes|cites` relations — as ordinary tagged deltas
 * through the one write path (ADR-0034/0031/0005).
 *
 * SUBPHASES §9D test list: conformance (in the adapter package);
 * **skeleton-only mode** (budget 0 → byte-identical floor); **recorded
 * goldens** (replay from the committed fixture store, zero network/keys);
 * the **extraction eval floor** lives in `evals/` (see evals/README.md).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const cli = resolve(repoRoot, 'apps/cli/dist/main.js');
const goldensDir = resolve(repoRoot, 'fixtures/goldens/cli');
const inputsRel = 'fixtures/.cut-inputs';
const UPDATE = process.env.UPDATE_GOLDENS === '1';

const corpusRel = 'fixtures/corpora/argument/pedestrian-centers.md';
const fixturesRel = 'fixtures/ai/enrich.argument.fixtures.json';
const skeletonRel = `${inputsRel}/arg-pedestrian.meridian.json`;
const enrichedRel = `${inputsRel}/arg-pedestrian.enriched.meridian.json`;

/** Run the CLI with every AI key stripped from the environment (ADR-0030). */
function run(args: string[]) {
  const env = { ...process.env };
  delete env['ANTHROPIC_API_KEY'];
  delete env['OPENAI_API_KEY'];
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, encoding: 'utf8', env });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status };
}

function compareGolden(name: string, actual: string): void {
  const golden = resolve(goldensDir, name);
  if (UPDATE) {
    writeFileSync(golden, actual, 'utf8');
    return;
  }
  expect(existsSync(golden), `golden ${name} missing — run pnpm goldens:update:cli`).toBe(true);
  expect(actual).toBe(readFileSync(golden, 'utf8'));
}

const REPLAY = ['--ai-mode', 'replay', '--ai-provider', 'mock', '--ai-fixtures', fixturesRel];

beforeAll(() => {
  mkdirSync(resolve(repoRoot, inputsRel), { recursive: true });
  const ing = run(['ingest', corpusRel, '--adapter', 'argument', '--out', skeletonRel]);
  if (ing.code !== 0) throw new Error(`ingest failed (code ${ing.code}): ${ing.stderr}`);
  if (UPDATE) {
    mkdirSync(resolve(repoRoot, 'fixtures/ai'), { recursive: true });
    const rec = run(['ai', 'enrich', skeletonRel, '--ai-mode', 'record', '--ai-fixtures', fixturesRel, '--out', enrichedRel]);
    if (rec.code !== 0) throw new Error(`record failed (code ${rec.code}): ${rec.stderr}`);
  } else {
    const rep = run(['ai', 'enrich', skeletonRel, ...REPLAY, '--out', enrichedRel]);
    if (rep.code !== 0) throw new Error(`replay enrich failed (code ${rep.code}): ${rep.stderr}`);
  }
});

describe('meridian ai enrich — argument map (replay, zero network)', () => {
  it('the skeleton ingest is byte-deterministic and valid', () => {
    const again = `${inputsRel}/arg-pedestrian.again.meridian.json`;
    const r = run(['ingest', corpusRel, '--adapter', 'argument', '--out', again]);
    expect(r.code).toBe(0);
    expect(readFileSync(resolve(repoRoot, again), 'utf8')).toBe(
      readFileSync(resolve(repoRoot, skeletonRel), 'utf8'),
    );
    expect(run(['validate', skeletonRel]).code).toBe(0);
  });

  it('replays the committed fixture set: report golden, valid output', () => {
    const r = run(['ai', 'enrich', skeletonRel, ...REPLAY, '--out', enrichedRel, '--json']);
    expect(r.code).toBe(0);
    compareGolden('enrich.arg.pedestrian.replay.json', r.stdout);
    expect(run(['validate', enrichedRel]).code).toBe(0);
  });

  it('the argument map is typed, anchored, and fully provenance-tagged (ADR-0031)', () => {
    const doc = JSON.parse(readFileSync(resolve(repoRoot, enrichedRel), 'utf8')) as {
      graphs: {
        nodes: { id: string; kind: string; provenance: Record<string, unknown> }[];
        edges: { kind: string; src: string; dst: string }[];
      }[];
    };
    const nodes = doc.graphs.flatMap((g) => g.nodes);
    const edges = doc.graphs.flatMap((g) => g.edges);
    const byId = new Map(nodes.map((n) => [n.id, n]));

    const mapKinds = new Set(['arg:thesis', 'arg:claim', 'arg:premise', 'arg:objection', 'arg:evidence']);
    const mapNodes = nodes.filter((n) => mapKinds.has(n.kind));
    expect(mapNodes.length).toBeGreaterThan(8); // ≥ 1 per prose paragraph in mock
    for (const n of mapNodes) {
      expect(n.provenance.origin).toBe('ai');
      expect(n.provenance.providerId).toBe('mock');
      expect(typeof n.provenance.inputHash).toBe('string');
    }

    // Every map node is anchored to a source paragraph via arg:cites.
    const cites = edges.filter((e) => e.kind === 'arg:cites');
    const anchored = new Set(cites.map((e) => e.src));
    for (const n of mapNodes) expect(anchored.has(n.id), `${n.id} anchored`).toBe(true);
    for (const e of cites) expect(byId.get(e.dst)?.kind).toBe('arg:paragraph');

    // Typed intra-extraction relations survive (mock emits premise → claim).
    const supports = edges.filter((e) => e.kind === 'arg:supports');
    expect(supports.length).toBeGreaterThan(0);
    for (const e of supports) {
      expect(mapKinds.has(byId.get(e.src)!.kind)).toBe(true);
      expect(mapKinds.has(byId.get(e.dst)!.kind)).toBe(true);
    }

    // The skeleton is untouched.
    for (const n of nodes.filter((x) => x.kind.startsWith('arg:paragraph') || x.kind === 'arg:sentence')) {
      expect(n.provenance.origin).toBe('source');
    }
  });

  it('re-running over the enriched document is a byte-identical no-op (idempotent merge)', () => {
    const second = `${inputsRel}/arg-pedestrian.enriched2.meridian.json`;
    const r = run(['ai', 'enrich', enrichedRel, '--out', second, '--json']);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout) as {
      argmap: { added: number; unchanged: number; replaced: number };
    };
    expect(report.argmap.added).toBe(0);
    expect(report.argmap.replaced).toBe(0);
    expect(report.argmap.unchanged).toBe(8);
    expect(readFileSync(resolve(repoRoot, second), 'utf8')).toBe(
      readFileSync(resolve(repoRoot, enrichedRel), 'utf8'),
    );
  });

  it('skeleton-only mode: budget 0 floors every paragraph and the skeleton stands', () => {
    const floored = `${inputsRel}/arg-pedestrian.floored.meridian.json`;
    const r = run(['ai', 'enrich', skeletonRel, '--budget', '0', '--out', floored, '--json']);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout) as { argmap: { added: number; floored: number } };
    expect(report.argmap.added).toBe(0);
    expect(report.argmap.floored).toBe(8);
    const parse = (rel: string) =>
      JSON.parse(readFileSync(resolve(repoRoot, rel), 'utf8')) as { producer?: unknown };
    const a = parse(floored);
    const b = parse(skeletonRel);
    delete a.producer;
    delete b.producer;
    expect(a).toEqual(b);
  });
});

describe('meridian ai enrich — argument ingest→zoom goldens (replay)', () => {
  function probeMaxLevel(docRel: string): number {
    const r = run(['cut', docRel, '--level', '0', '--json']);
    if (r.code !== 0) throw new Error(`probe cut ${docRel} failed (code ${r.code}): ${r.stderr}`);
    return (JSON.parse(r.stdout) as { maxLevel: number }).maxLevel;
  }

  it('the skeleton zooms at every level (the AI-less floor is a real map)', () => {
    const max = probeMaxLevel(skeletonRel);
    expect(max).toBe(2); // essay → paragraph → sentence
    for (let level = 0; level <= max; level++) {
      const r = run(['cut', skeletonRel, '--level', String(level)]);
      expect(r.code).toBe(0);
      compareGolden(`cut.arg.pedestrian.l${level}.txt`, r.stdout);
    }
  });

  it('the enriched document zooms with the argument map overlaid', () => {
    const max = probeMaxLevel(enrichedRel);
    for (let level = 0; level <= max; level++) {
      const r = run(['cut', enrichedRel, '--level', String(level)]);
      expect(r.code).toBe(0);
      compareGolden(`cut.arg.pedestrian.enriched.l${level}.txt`, r.stdout);
    }
  });
});
