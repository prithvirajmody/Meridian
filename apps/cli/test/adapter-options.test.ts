/**
 * `meridian ingest` adapter options (ROADMAP Phase 7 §6) and the composition
 * root's filesystem-owner responsibilities (§12 failure-case row):
 *
 * - include/exclude globs and the `--lang` allowlist filter the walk;
 * - a >10MB file is excluded by the ADR-0027 budget policy — it contributes a
 *   `code:module` flagged `code:excluded: 'oversize'`, cold (no detail),
 *   non-resolvable (no `code:body-span` marker), and is never parsed;
 * - a symlink cycle at the root neither hangs nor duplicates content.
 *
 * These drive the real built CLI over throwaway temp repos.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const cli = resolve(repoRoot, 'apps/cli/dist/main.js');

function run(args: string[]) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status, signal: r.signal };
}

interface DocNode {
  id: string;
  kind: string;
  label: string;
  attrs: Record<string, unknown>;
  detail?: unknown;
}

function ingestJson(args: string[]): { stats: { nodesByKind: Record<string, number> }; nodes: DocNode[] } {
  const r = run(['ingest', ...args, '--json']);
  expect(r.stderr).toBe('');
  expect(r.code).toBe(0);
  const parsed = JSON.parse(r.stdout) as {
    stats: { nodesByKind: Record<string, number> };
    document: { graphs: Array<{ nodes: DocNode[] }> };
  };
  const nodes = parsed.document.graphs.flatMap((g) => g.nodes);
  return { stats: parsed.stats, nodes };
}

const scratch = mkdtempSync(join(tmpdir(), 'meridian-opts-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function makeRepo(name: string, files: Record<string, string>): string {
  const dir = join(scratch, name);
  for (const [rel, text] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(resolve(full, '..'), { recursive: true });
    writeFileSync(full, text);
  }
  return dir;
}

describe('adapter options — include / exclude globs and --lang allowlist', () => {
  const repo = makeRepo('mixed', {
    'src/a.ts': 'export function a(): number { return 1; }\n',
    'src/b.ts': 'export function b(): number { return 2; }\n',
    'src/__tests__/a.test.ts': 'export function t(): number { return 0; }\n',
    'app/main.py': 'def main():\n    return 3\n',
    'vendor/lib.ts': 'export const v = 4;\n',
  });

  const modules = (a: string[]): string[] =>
    ingestJson([repo, ...a]).nodes.filter((n) => n.kind === 'code:module').map((n) => n.label).sort();

  it('no filters: every TS + Python file is a module', () => {
    expect(modules([])).toEqual(['a.test.ts', 'a.ts', 'b.ts', 'lib.ts', 'main.py']);
  });

  it('--lang typescript drops the Python module', () => {
    expect(modules(['--lang', 'typescript'])).toEqual(['a.test.ts', 'a.ts', 'b.ts', 'lib.ts']);
  });

  it('--lang python keeps only Python', () => {
    expect(modules(['--lang', 'python'])).toEqual(['main.py']);
  });

  it('--include restricts to matching paths', () => {
    expect(modules(['--include', 'src/**'])).toEqual(['a.test.ts', 'a.ts', 'b.ts']);
  });

  it('--exclude drops matching paths; exclude wins over include', () => {
    expect(modules(['--include', 'src/**', '--exclude', '**/__tests__/**'])).toEqual(['a.ts', 'b.ts']);
  });

  it('globs and allowlist compose', () => {
    expect(modules(['--include', 'src/**,app/**', '--exclude', '**/*.test.ts', '--lang', 'typescript'])).toEqual([
      'a.ts',
      'b.ts',
    ]);
  });

  it('an unknown --lang is a usage error (exit 2)', () => {
    const r = run(['ingest', repo, '--lang', 'rust']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown language');
  });
});

describe('adapter options — ADR-0027 oversize budget policy (>10MB excluded)', () => {
  it('a >10MB file becomes a cold, flagged, non-resolvable module and is never parsed', () => {
    // 11 MB of a single line: over the 10 MB byte threshold, so excluded before
    // any parse. Content is irrelevant (never walked); shape it like a comment.
    const big = '// generated bundle\n' + 'x'.repeat(11 * 1024 * 1024);
    const repo = makeRepo('oversize', {
      'src/real.ts': 'export function real(): number { return 1; }\n',
      'src/bundle.generated.ts': big,
    });
    const { nodes } = ingestJson([repo]);
    const bundle = nodes.find((n) => n.label === 'bundle.generated.ts');
    expect(bundle).toBeDefined();
    expect(bundle!.kind).toBe('code:module');
    expect(bundle!.attrs['code:excluded']).toBe('oversize');
    expect(bundle!.detail).toBeUndefined(); // cold
    // Never parsed ⇒ no declarations underneath and no body-span markers.
    expect(bundle!.attrs['code:body-span']).toBeUndefined();
    // The sibling real module still parsed normally.
    const real = nodes.find((n) => n.label === 'real.ts');
    expect(real).toBeDefined();
    expect(real!.attrs['code:excluded']).toBeUndefined();
    // No body/CFG nodes were persisted for the excluded file.
    expect(nodes.some((n) => ['code:block', 'code:stmt', 'code:expr'].includes(n.kind))).toBe(false);
  });
});

describe('adapter options — symlink cycle at the composition root', () => {
  it('a directory symlink cycle neither hangs nor duplicates content', () => {
    const repo = makeRepo('symlinked', {
      'pkg/a.ts': 'export function a(): number { return 1; }\n',
    });
    // pkg/loop → the repo root (cycle: pkg/loop/pkg/loop/…) and self → '.'
    symlinkSync(repo, join(repo, 'pkg', 'loop'), 'dir');
    symlinkSync(repo, join(repo, 'self'), 'dir');
    const r = run(['ingest', repo, '--json']);
    // Terminated (no timeout signal) with a clean exit.
    expect(r.signal).toBeNull();
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as { document: { graphs: Array<{ nodes: DocNode[] }> } };
    const modules = parsed.document.graphs.flatMap((g) => g.nodes).filter((n) => n.kind === 'code:module');
    // Exactly one module — the symlinks were not followed, nothing duplicated.
    expect(modules.map((m) => m.label)).toEqual(['a.ts']);
  });
});
