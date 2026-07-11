/**
 * `meridian layout` SVG golden tests (ROADMAP Phase 4 §12, Integration row:
 * *"`meridian layout --svg` goldens (SVG normalized before diff)"*; subphase
 * 4B). Every byte of the exported SVG is pinned for **grid and tree over the
 * markdown corpus at every level**; goldens change only via
 * `pnpm goldens:update` (§5.2), never by hand.
 *
 * Normalization: the exporter itself emits canonical SVG (elements in
 * ascending id/(src,dst,kind) order, fixed 2-decimal precision, `-0` folded,
 * LF, one element per line), so "normalized before diff" is byte equality on
 * its output — no post-processing pass is needed or allowed.
 *
 * Inputs are ingested through the real CLI pipeline into
 * `fixtures/.cut-inputs/` (gitignored; byte-deterministic ingest), exactly as
 * the cut goldens do — so these goldens exercise real Phase 3 cuts end-to-end:
 * ingest → cut → layout → SVG.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const cli = resolve(repoRoot, 'apps/cli/dist/main.js');
const goldensDir = resolve(repoRoot, 'fixtures/goldens/cli');
const inputsRel = 'fixtures/.cut-inputs';
const outDir = resolve(tmpdir(), `meridian-layout-goldens-${process.pid}`);
const UPDATE = process.env.UPDATE_GOLDENS === '1';

function run(args: string[]) {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, encoding: 'utf8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status };
}

/** The finest level for a document, read from the sibling command. */
function probeMaxLevel(docRel: string): number {
  const r = run(['cut', docRel, '--level', '0', '--json']);
  if (r.code !== 0) throw new Error(`probe cut ${docRel} failed (code ${r.code}): ${r.stderr}`);
  return (JSON.parse(r.stdout) as { maxLevel: number }).maxLevel;
}

interface Case {
  golden: string;
  docRel: string;
  provider: string;
  level: number;
}

const cases: Case[] = [];

// --- Markdown corpus: ingest through the CLI, then lay out at every level ---
mkdirSync(resolve(repoRoot, inputsRel), { recursive: true });
mkdirSync(outDir, { recursive: true });
const CORPUS = ['basic', 'links', 'commonmark-edges', 'pathological-nesting', 'no-headings', 'empty'];
for (const name of CORPUS) {
  const docRel = `${inputsRel}/${name}.meridian.json`;
  const ing = run(['ingest', `fixtures/corpora/markdown/${name}.md`, '--out', docRel]);
  if (ing.code !== 0) throw new Error(`ingest ${name} failed (code ${ing.code}): ${ing.stderr}`);
  const maxLevel = probeMaxLevel(docRel);
  for (const provider of ['grid', 'tree', 'elk-layered']) {
    for (let level = 0; level <= maxLevel; level++) {
      cases.push({ golden: `layout.md.${name}.${provider}.l${level}.svg`, docRel, provider, level });
    }
  }
}

describe('meridian layout — SVG golden files', () => {
  it.each(cases)('$golden', ({ golden, docRel, provider, level }) => {
    const svgPath = resolve(outDir, golden);
    const r = run(['layout', docRel, '--svg', svgPath, '--provider', provider, '--level', String(level)]);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    const svg = readFileSync(svgPath, 'utf8');
    const goldenPath = resolve(goldensDir, golden);
    if (UPDATE) {
      mkdirSync(goldensDir, { recursive: true });
      writeFileSync(goldenPath, svg);
    } else {
      expect(existsSync(goldenPath), `golden missing: ${golden} — run \`pnpm goldens:update\``).toBe(true);
      expect(svg).toBe(readFileSync(goldenPath, 'utf8'));
    }
  });
});

/**
 * Subphase 4C exit criterion: `grid`/`tree` run **inside the ADR-0017 Comlink
 * worker** must produce byte-identical output to the main-thread path — the
 * *same committed goldens*. `--worker` routes the CLI's layout through
 * `LayoutWorkerHost` + a `worker_threads` worker; every corpus×provider×level
 * case is re-checked against the golden it already owns. Never regenerated in
 * this suite (no UPDATE branch): the goldens are authored by the main-thread
 * path above; here the worker must match them exactly.
 */
describe('meridian layout --worker — byte-identical to committed goldens (4C)', () => {
  it.each(cases)('$golden (in worker)', ({ golden, docRel, provider, level }) => {
    const goldenPath = resolve(goldensDir, golden);
    if (!existsSync(goldenPath)) return; // covered by the main-thread suite's guard
    const svgPath = resolve(outDir, `worker.${golden}`);
    const r = run(['layout', docRel, '--svg', svgPath, '--provider', provider, '--level', String(level), '--worker']);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(readFileSync(svgPath, 'utf8')).toBe(readFileSync(goldenPath, 'utf8'));
  });
});

describe('meridian layout — contract behavior (no goldens: contracts, not bytes)', () => {
  const doc = `${inputsRel}/links.meridian.json`;

  it('is deterministic: two runs produce byte-identical SVG', () => {
    const p1 = resolve(outDir, 'det-1.svg');
    const p2 = resolve(outDir, 'det-2.svg');
    expect(run(['layout', doc, '--svg', p1, '--level', '1']).code).toBe(0);
    expect(run(['layout', doc, '--svg', p2, '--level', '1']).code).toBe(0);
    expect(readFileSync(p1, 'utf8')).toBe(readFileSync(p2, 'utf8'));
  });

  it('defaults to the grid provider and level 0', () => {
    const p = resolve(outDir, 'default.svg');
    const r = run(['layout', doc, '--svg', p, '--json']);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout) as { provider: string; level: number };
    expect(j.provider).toBe('grid');
    expect(j.level).toBe(0);
  });

  it('rejects an unknown provider with exit 2', () => {
    const r = run(['layout', doc, '--svg', resolve(outDir, 'x.svg'), '--provider', 'no-such-provider']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown provider');
  });

  it('accepts the elk-layered provider (4D)', () => {
    const p = resolve(outDir, 'elk.svg');
    const r = run(['layout', doc, '--svg', p, '--provider', 'elk-layered', '--level', '1', '--json']);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect((JSON.parse(r.stdout) as { provider: string }).provider).toBe('elk-layered');
  });

  it('requires --svg (usage, exit 2)', () => {
    expect(run(['layout', doc]).code).toBe(2);
  });

  it('rejects giving both --level and --zoom (usage, exit 2)', () => {
    const r = run(['layout', doc, '--svg', resolve(outDir, 'y.svg'), '--level', '0', '--zoom', '0.5']);
    expect(r.code).toBe(2);
  });

  it('rejects an invalid document with exit 1', () => {
    const r = run(['layout', 'fixtures/invalid/dangling-edge.meridian.json', '--svg', resolve(outDir, 'z.svg'), '--level', '0']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('INVALID');
  });
});
