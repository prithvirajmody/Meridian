/**
 * Phase 2 acceptance (roadmap §11): `meridian ingest` produces a valid,
 * deterministic, stable-ID graph document — same file, byte-identical output
 * — and the written document round-trips through `meridian validate`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const cli = resolve(repoRoot, 'apps/cli/dist/main.js');
const corpus = 'fixtures/corpora/markdown';

function run(args: string[]) {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, encoding: 'utf8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status };
}

const scratch = mkdtempSync(join(tmpdir(), 'meridian-ingest-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('ingest determinism & round-trip', () => {
  it('same file → byte-identical document (stable IDs, I6/U4)', () => {
    const outA = join(scratch, 'a.meridian.json');
    const outB = join(scratch, 'b.meridian.json');
    expect(run(['ingest', `${corpus}/basic.md`, '--out', outA]).code).toBe(0);
    expect(run(['ingest', `${corpus}/basic.md`, '--out', outB]).code).toBe(0);
    const a = readFileSync(outA, 'utf8');
    expect(a.length).toBeGreaterThan(0);
    expect(readFileSync(outB, 'utf8')).toBe(a);
  });

  it('the written document passes meridian validate', () => {
    const outFile = join(scratch, 'links.meridian.json');
    expect(run(['ingest', `${corpus}/links.md`, '--out', outFile]).code).toBe(0);
    const v = run(['validate', outFile]);
    expect(v.code).toBe(0);
    expect(v.stdout).toContain('OK');
  });

  it('the written document is inspectable through the ordinary pipeline', () => {
    const outFile = join(scratch, 'basic.meridian.json');
    expect(run(['ingest', `${corpus}/basic.md`, '--out', outFile]).code).toBe(0);
    const statsRun = run(['stats', outFile, '--json']);
    expect(statsRun.code).toBe(0);
    const parsed = JSON.parse(statsRun.stdout) as { stats: { nodesByKind: Record<string, number> } };
    expect(parsed.stats.nodesByKind['doc:section']).toBeGreaterThan(0);
  });

  it('--json report is stable across runs and parseable', () => {
    const a = run(['ingest', `${corpus}/commonmark-edges.md`, '--json']);
    const b = run(['ingest', `${corpus}/commonmark-edges.md`, '--json']);
    expect(a.code).toBe(0);
    expect(a.stdout).toBe(b.stdout);
    const parsed = JSON.parse(a.stdout) as { document: { formatVersion: number } };
    expect(parsed.document.formatVersion).toBe(1);
  });
});
