/**
 * `meridian cut` golden-file tests (ROADMAP Phase 3 §12, Integration row:
 * *"`meridian cut` goldens across the markdown corpus at every level"*).
 * Every byte of `cut` output is pinned; goldens change only via
 * `pnpm goldens:update` (§5.2), never by hand.
 *
 * Inputs. `cut` operates on a GraphDocument, so the markdown corpus is first
 * **ingested through the real CLI pipeline** into `fixtures/.cut-inputs/`
 * (gitignored, regenerated on every run — the ingest is byte-deterministic,
 * so the derived cut golden is stable). The hand-written `fixtures/valid/`
 * documents are cut directly; they carry the cross-level edges that exercise
 * induced-edge aggregation (ADR-0013). The level range per document is probed
 * from the command under test (`cut … --json`'s `maxLevel`), so "every level"
 * stays correct if a fixture's depth changes.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const cli = resolve(repoRoot, 'apps/cli/dist/main.js');
const goldensDir = resolve(repoRoot, 'fixtures/goldens/cli');
const inputsRel = 'fixtures/.cut-inputs';
const UPDATE = process.env.UPDATE_GOLDENS === '1';

function run(args: string[]) {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, encoding: 'utf8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status };
}

/** The finest level for a document, read from the command under test. */
function probeMaxLevel(docRel: string): number {
  const r = run(['cut', docRel, '--level', '0', '--json']);
  if (r.code !== 0) throw new Error(`probe cut ${docRel} failed (code ${r.code}): ${r.stderr}`);
  return (JSON.parse(r.stdout) as { maxLevel: number }).maxLevel;
}

interface Case {
  golden: string;
  args: string[];
}

const cases: Case[] = [];

// --- Markdown corpus: ingest through the CLI, then cut at every level. -------
mkdirSync(resolve(repoRoot, inputsRel), { recursive: true });
const CORPUS = ['basic', 'links', 'commonmark-edges', 'pathological-nesting', 'no-headings', 'empty'];
for (const name of CORPUS) {
  const docRel = `${inputsRel}/${name}.meridian.json`;
  const ing = run(['ingest', `fixtures/corpora/markdown/${name}.md`, '--out', docRel]);
  if (ing.code !== 0) throw new Error(`ingest ${name} failed (code ${ing.code}): ${ing.stderr}`);
  const maxLevel = probeMaxLevel(docRel);
  for (let level = 0; level <= maxLevel; level++) {
    cases.push({ golden: `cut.md.${name}.l${level}.txt`, args: ['cut', docRel, '--level', String(level)] });
  }
}
// One --json golden over the corpus (links carries portal-rule induced edges).
cases.push({ golden: 'cut.md.links.l1.json', args: ['cut', `${inputsRel}/links.meridian.json`, '--level', '1', '--json'] });

// --- Hand-written valid documents: every level (rich induced edges). ---------
for (const name of ['deep-nest', 'portal-links', 'flat-simple', 'unicode-labels']) {
  const docRel = `fixtures/valid/${name}.meridian.json`;
  const maxLevel = probeMaxLevel(docRel);
  for (let level = 0; level <= maxLevel; level++) {
    cases.push({ golden: `cut.${name}.l${level}.txt`, args: ['cut', docRel, '--level', String(level)] });
  }
}

// --- Targeted goldens: --json, --focus, --zoom. ------------------------------
const deepNest = 'fixtures/valid/deep-nest.meridian.json';
cases.push({ golden: 'cut.deep-nest.l0.json', args: ['cut', deepNest, '--level', '0', '--json'] });
cases.push({ golden: 'cut.deep-nest.l1.focus.txt', args: ['cut', deepNest, '--level', '1', '--focus', 'n-parse'] });
cases.push({ golden: 'cut.deep-nest.zoom-050.txt', args: ['cut', deepNest, '--zoom', '0.5'] });

describe('meridian cut — golden files', () => {
  it.each(cases)('$golden', ({ golden, args }) => {
    const r = run(args);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    const goldenPath = resolve(goldensDir, golden);
    if (UPDATE) {
      mkdirSync(goldensDir, { recursive: true });
      writeFileSync(goldenPath, r.stdout);
    } else {
      expect(existsSync(goldenPath), `golden missing: ${golden} — run \`pnpm goldens:update\``).toBe(true);
      expect(r.stdout).toBe(readFileSync(goldenPath, 'utf8'));
    }
  });
});

describe('meridian cut — failure & contract behavior (no goldens: contracts, not bytes)', () => {
  it('rejects giving both --level and --zoom (usage, exit 2)', () => {
    const r = run(['cut', deepNest, '--level', '0', '--zoom', '0.5']);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
  });

  it('rejects giving neither --level nor --zoom (usage, exit 2)', () => {
    const r = run(['cut', deepNest]);
    expect(r.code).toBe(2);
  });

  it('rejects a non-integer level and an out-of-range zoom (usage, exit 2)', () => {
    expect(run(['cut', deepNest, '--level', 'abc']).code).toBe(2);
    expect(run(['cut', deepNest, '--zoom', '5']).code).toBe(2);
    expect(run(['cut', deepNest, '--zoom', '-1']).code).toBe(2);
  });

  it('reports a missing --focus node on stderr with exit 1', () => {
    const r = run(['cut', deepNest, '--level', '0', '--focus', 'n-nope']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not found');
    expect(r.stdout).toBe('');
  });

  it('rejects an invalid document with exit 1', () => {
    const r = run(['cut', 'fixtures/invalid/dangling-edge.meridian.json', '--level', '0']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('INVALID');
  });

  it('--json is stable across runs and parseable', () => {
    const a = run(['cut', deepNest, '--level', '1', '--json']);
    const b = run(['cut', deepNest, '--level', '1', '--json']);
    expect(a.stdout).toBe(b.stdout);
    expect(() => JSON.parse(a.stdout)).not.toThrow();
  });
});
