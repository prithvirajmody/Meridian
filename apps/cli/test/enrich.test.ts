/**
 * Phase 9C acceptance: `meridian ai enrich` layers AI topics + claims over the
 * deterministic conversation skeleton, as ordinary tagged deltas through the
 * one write path (ADR-0034/0031/0005).
 *
 * The SUBPHASES §9C test list, verbatim:
 * - **enrichment idempotency** — a re-run over the enriched document changes
 *   nothing (same `inputHash` ⇒ no-op; byte-identical output);
 * - **AI-unavailable → degraded-but-working skeleton** — a budget of zero
 *   floors every unit and the output is byte-identical to the skeleton;
 * - **full ingest→zoom goldens in replay** — the corpus conversation is
 *   ingested, enriched from the committed fixture set with zero network and
 *   zero keys, and cut at every level against pinned goldens.
 *
 * Fixture discipline (ADR-0030): `fixtures/ai/enrich.conversation.fixtures.json`
 * is the committed record/replay store, (re)recorded from the deterministic
 * mock provider by the documented regen command (`pnpm goldens:update:cli`,
 * i.e. UPDATE_GOLDENS=1) — never edited by hand. In replay a cache miss is a
 * hard failure, proven below.
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

const corpusRel = 'fixtures/corpora/conversation/claude-two-topics.json';
const fixturesRel = 'fixtures/ai/enrich.conversation.fixtures.json';
const skeletonRel = `${inputsRel}/conv-two-topics.meridian.json`;
const enrichedRel = `${inputsRel}/conv-two-topics.enriched.meridian.json`;

/** Run the CLI with every AI key stripped from the environment, so a passing
 * mock/replay run proves it never needed the network (ADR-0030). */
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
  const ing = run(['ingest', corpusRel, '--adapter', 'conversation', '--out', skeletonRel]);
  if (ing.code !== 0) throw new Error(`ingest failed (code ${ing.code}): ${ing.stderr}`);
  if (UPDATE) {
    // The documented fixture-regen path: record the deterministic mock's
    // responses into the committed store (live re-record = human step, 8C).
    mkdirSync(resolve(repoRoot, 'fixtures/ai'), { recursive: true });
    const rec = run(['ai', 'enrich', skeletonRel, '--ai-mode', 'record', '--ai-fixtures', fixturesRel, '--out', enrichedRel]);
    if (rec.code !== 0) throw new Error(`record failed (code ${rec.code}): ${rec.stderr}`);
  } else {
    const rep = run(['ai', 'enrich', skeletonRel, ...REPLAY, '--out', enrichedRel]);
    if (rep.code !== 0) throw new Error(`replay enrich failed (code ${rep.code}): ${rep.stderr}`);
  }
});

describe('meridian ai enrich — skeleton in, enriched document out (replay, zero network)', () => {
  it('the skeleton ingest is byte-deterministic and valid', () => {
    const again = `${inputsRel}/conv-two-topics.again.meridian.json`;
    const r = run(['ingest', corpusRel, '--adapter', 'conversation', '--out', again]);
    expect(r.code).toBe(0);
    expect(readFileSync(resolve(repoRoot, again), 'utf8')).toBe(
      readFileSync(resolve(repoRoot, skeletonRel), 'utf8'),
    );
    expect(run(['validate', skeletonRel]).code).toBe(0);
  });

  it('replays the committed fixture set: report golden, valid output', () => {
    const r = run(['ai', 'enrich', skeletonRel, ...REPLAY, '--out', enrichedRel, '--json']);
    expect(r.code).toBe(0);
    compareGolden('enrich.conv.two-topics.replay.json', r.stdout);
    expect(run(['validate', enrichedRel]).code).toBe(0);
  });

  it('the enriched document carries AI topics and claims with full provenance (ADR-0031)', () => {
    const doc = JSON.parse(readFileSync(resolve(repoRoot, enrichedRel), 'utf8')) as {
      graphs: {
        id: string;
        nodes: {
          id: string;
          kind: string;
          label: string;
          attrs?: Record<string, unknown>;
          provenance: Record<string, unknown>;
        }[];
        edges: { kind: string; src: string; dst: string; provenance: Record<string, unknown> }[];
      }[];
    };
    const nodes = doc.graphs.flatMap((g) => g.nodes);
    const edges = doc.graphs.flatMap((g) => g.edges);

    const topics = nodes.filter((n) => n.kind === 'conv:topic');
    expect(topics.length).toBeGreaterThanOrEqual(2); // the two-subject corpus splits
    for (const t of topics) {
      expect(t.provenance.origin).toBe('ai');
      expect(t.provenance.providerId).toBe('mock');
      expect(t.provenance.model).toBe('mock-model');
      expect(typeof t.provenance.promptVersion).toBe('string');
      expect(typeof t.provenance.inputHash).toBe('string');
      expect(typeof t.attrs?.['ai:summary']).toBe('string');
    }

    const claims = nodes.filter((n) => n.kind === 'conv:claim');
    expect(claims.length).toBeGreaterThan(0);
    for (const c of claims) {
      expect(c.provenance.origin).toBe('ai');
      expect(typeof c.provenance.inputHash).toBe('string');
    }
    const about = edges.filter((e) => e.kind === 'conv:about');
    expect(about.length).toBe(claims.length); // every claim is anchored to its message
    expect(edges.some((e) => e.kind === 'conv:refers-back')).toBe(true);

    // The skeleton is untouched: every source-origin element still source-origin.
    const messages = nodes.filter((n) => n.kind === 'conv:message');
    expect(messages).toHaveLength(12);
    for (const m of messages) expect(m.provenance.origin).toBe('source');
  });

  it('mock mode produces the identical document — the fixtures faithfully captured it', () => {
    const mockOut = `${inputsRel}/conv-two-topics.mock.meridian.json`;
    const r = run(['ai', 'enrich', skeletonRel, '--out', mockOut]);
    expect(r.code).toBe(0);
    expect(readFileSync(resolve(repoRoot, mockOut), 'utf8')).toBe(
      readFileSync(resolve(repoRoot, enrichedRel), 'utf8'),
    );
  });
});

describe('meridian ai enrich — idempotent merge (ADR-0034, keyed by inputHash)', () => {
  it('re-running over the enriched document is a byte-identical no-op', () => {
    const second = `${inputsRel}/conv-two-topics.enriched2.meridian.json`;
    const r = run(['ai', 'enrich', enrichedRel, '--out', second, '--json']);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout) as {
      topics: { layered: number; unchanged: number; replaced: number };
      claims: { added: number; unchanged: number; replaced: number };
    };
    expect(report.topics).toMatchObject({ layered: 0, replaced: 0, unchanged: 1 });
    expect(report.claims.added).toBe(0);
    expect(report.claims.replaced).toBe(0);
    expect(report.claims.unchanged).toBeGreaterThan(0);
    expect(readFileSync(resolve(repoRoot, second), 'utf8')).toBe(
      readFileSync(resolve(repoRoot, enrichedRel), 'utf8'),
    );
  });
});

describe('meridian ai enrich — failure regimes (ADR-0030/0032)', () => {
  it('AI unavailable (budget 0) → degraded-but-working skeleton, byte-identical', () => {
    const floored = `${inputsRel}/conv-two-topics.floored.meridian.json`;
    const r = run(['ai', 'enrich', skeletonRel, '--budget', '0', '--out', floored, '--json']);
    expect(r.code).toBe(0); // degradation is not an error (ADR-0032)
    const report = JSON.parse(r.stdout) as {
      topics: { layered: number; floored: number };
      claims: { added: number; floored: number };
    };
    expect(report.topics.layered).toBe(0);
    expect(report.topics.floored).toBeGreaterThan(0);
    expect(report.claims.added).toBe(0);
    expect(report.claims.floored).toBe(12);
    // Identical content; only the producer stamp differs (adapter vs CLI).
    const parse = (rel: string) =>
      JSON.parse(readFileSync(resolve(repoRoot, rel), 'utf8')) as { producer: unknown; [k: string]: unknown };
    const flooredDoc = parse(floored);
    const skeletonDoc = parse(skeletonRel);
    expect(flooredDoc.producer).toEqual({ name: '@meridian/cli', version: '0.1.0' });
    delete (flooredDoc as { producer?: unknown }).producer;
    delete (skeletonDoc as { producer?: unknown }).producer;
    expect(flooredDoc).toEqual(skeletonDoc);
  });

  it('replay with an empty cache is a hard replay_miss, never a network fallback', () => {
    const r = run(['ai', 'enrich', skeletonRel, '--ai-mode', 'replay', '--ai-provider', 'mock']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('replay');
  });

  it('live mode refuses without explicit consent', () => {
    const r = run(['ai', 'enrich', skeletonRel, '--ai-mode', 'live']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--ai-consent');
  });

  it('a non-conversation document is refused with a located message', () => {
    const mdDoc = `${inputsRel}/enrich-md-probe.meridian.json`;
    const ing = run(['ingest', 'fixtures/corpora/markdown/basic.md', '--out', mdDoc]);
    expect(ing.code).toBe(0);
    const r = run(['ai', 'enrich', mdDoc]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('conversation');
  });
});

describe('meridian ai enrich — ingest→zoom goldens (replay)', () => {
  /** The finest level for a document, read from the command under test. */
  function probeMaxLevel(docRel: string): number {
    const r = run(['cut', docRel, '--level', '0', '--json']);
    if (r.code !== 0) throw new Error(`probe cut ${docRel} failed (code ${r.code}): ${r.stderr}`);
    return (JSON.parse(r.stdout) as { maxLevel: number }).maxLevel;
  }

  it('the skeleton zooms at every level (degraded mode is the foundation)', () => {
    const max = probeMaxLevel(skeletonRel);
    expect(max).toBeGreaterThanOrEqual(2); // session → exchange → message
    for (let level = 0; level <= max; level++) {
      const r = run(['cut', skeletonRel, '--level', String(level)]);
      expect(r.code).toBe(0);
      compareGolden(`cut.conv.two-topics.l${level}.txt`, r.stdout);
    }
  });

  it('the enriched document zooms topics→messages at every level, AI labels visible', () => {
    const max = probeMaxLevel(enrichedRel);
    expect(max).toBeGreaterThanOrEqual(3); // session → topic → exchange → message
    for (let level = 0; level <= max; level++) {
      const r = run(['cut', enrichedRel, '--level', String(level)]);
      expect(r.code).toBe(0);
      compareGolden(`cut.conv.two-topics.enriched.l${level}.txt`, r.stdout);
    }
  });
});
