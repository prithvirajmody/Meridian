/**
 * CLI golden-file tests (ROADMAP Phase 0 §12): every byte of output for
 * every fixture is pinned. Goldens change only via `pnpm goldens:update` —
 * an explicit, reviewed regeneration (§5.2), never by hand.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const cli = resolve(repoRoot, 'apps/cli/dist/main.js');
const goldensDir = resolve(repoRoot, 'fixtures/goldens/cli');
const UPDATE = process.env.UPDATE_GOLDENS === '1';

function run(args: string[]) {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, encoding: 'utf8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status };
}

const V = 'fixtures/valid';
const I = 'fixtures/invalid';

interface Case {
  golden: string;
  args: string[];
  exit: number;
}

const cases: Case[] = [
  { golden: 'validate.deep-nest.txt', args: ['validate', `${V}/deep-nest.meridian.json`], exit: 0 },
  { golden: 'validate.deep-nest.json', args: ['validate', `${V}/deep-nest.meridian.json`, '--json'], exit: 0 },
  { golden: 'validate.flat-simple.txt', args: ['validate', `${V}/flat-simple.meridian.json`], exit: 0 },
  { golden: 'validate.unicode-labels.txt', args: ['validate', `${V}/unicode-labels.meridian.json`], exit: 0 },
  { golden: 'validate.portal-links.txt', args: ['validate', `${V}/portal-links.meridian.json`], exit: 0 },
  { golden: 'validate.dangling-edge.txt', args: ['validate', `${I}/dangling-edge.meridian.json`], exit: 1 },
  { golden: 'validate.dangling-edge.json', args: ['validate', `${I}/dangling-edge.meridian.json`, '--json'], exit: 1 },
  { golden: 'validate.cross-graph-edge.txt', args: ['validate', `${I}/cross-graph-edge.meridian.json`], exit: 1 },
  { golden: 'validate.containment-cycle.txt', args: ['validate', `${I}/containment-cycle.meridian.json`], exit: 1 },
  { golden: 'validate.deep-cycle-10.txt', args: ['validate', `${I}/deep-cycle-10.meridian.json`], exit: 1 },
  { golden: 'validate.duplicate-id.txt', args: ['validate', `${I}/duplicate-id.meridian.json`], exit: 1 },
  { golden: 'validate.shared-detail.txt', args: ['validate', `${I}/shared-detail.meridian.json`], exit: 1 },
  { golden: 'validate.root-mismatch.txt', args: ['validate', `${I}/root-mismatch.meridian.json`], exit: 1 },
  { golden: 'validate.missing-provenance.txt', args: ['validate', `${I}/missing-provenance.meridian.json`], exit: 1 },
  { golden: 'validate.bad-attr-key.txt', args: ['validate', `${I}/bad-attr-key.meridian.json`], exit: 1 },
  { golden: 'validate.unknown-version.txt', args: ['validate', `${I}/unknown-version.meridian.json`], exit: 1 },
  { golden: 'validate.missing-version.txt', args: ['validate', `${I}/missing-version.meridian.json`], exit: 1 },
  { golden: 'validate.malformed.txt', args: ['validate', `${I}/malformed.json`], exit: 1 },
  { golden: 'validate.truncated.txt', args: ['validate', `${I}/truncated.meridian.json`], exit: 1 },
  { golden: 'stats.deep-nest.txt', args: ['stats', `${V}/deep-nest.meridian.json`], exit: 0 },
  { golden: 'stats.deep-nest.json', args: ['stats', `${V}/deep-nest.meridian.json`, '--json'], exit: 0 },
  { golden: 'stats.unicode-labels.txt', args: ['stats', `${V}/unicode-labels.meridian.json`], exit: 0 },
  { golden: 'inspect.deep-nest.n-parse.txt', args: ['inspect', `${V}/deep-nest.meridian.json`, 'n-parse'], exit: 0 },
  { golden: 'inspect.deep-nest.n-parse.json', args: ['inspect', `${V}/deep-nest.meridian.json`, 'n-parse', '--json'], exit: 0 },
  { golden: 'inspect.deep-nest.n-util.txt', args: ['inspect', `${V}/deep-nest.meridian.json`, 'n-util'], exit: 0 },
];

describe('CLI golden files', () => {
  it.each(cases)('$golden', ({ golden, args, exit }) => {
    const r = run(args);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(exit);
    const goldenPath = resolve(goldensDir, golden);
    if (UPDATE) {
      mkdirSync(goldensDir, { recursive: true });
      writeFileSync(goldenPath, r.stdout);
    } else {
      expect(
        existsSync(goldenPath),
        `golden missing: ${golden} — run \`pnpm goldens:update\``,
      ).toBe(true);
      expect(r.stdout).toBe(readFileSync(goldenPath, 'utf8'));
    }
  });
});

describe('CLI failure behavior (no goldens: contracts, not bytes)', () => {
  it('inspect reports a missing node on stderr with exit 1', () => {
    const r = run(['inspect', `${V}/deep-nest.meridian.json`, 'n-does-not-exist']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not found');
    expect(r.stdout).toBe('');
  });

  it('usage and I/O errors exit 2 with help on stderr', () => {
    expect(run([]).code).toBe(2);
    expect(run(['frobnicate', 'x.json']).code).toBe(2);
    expect(run(['validate']).code).toBe(2);
    expect(run(['inspect', `${V}/deep-nest.meridian.json`]).code).toBe(2);
    expect(run(['validate', 'no/such/file.json']).code).toBe(2);
    expect(run(['validate', `${V}/deep-nest.meridian.json`, '--frob']).code).toBe(2);
  });

  it('help exits 0 when asked for explicitly', () => {
    expect(run(['help']).code).toBe(0);
  });

  it('--json output is parseable and stable across runs', () => {
    const a = run(['stats', `${V}/deep-nest.meridian.json`, '--json']);
    const b = run(['stats', `${V}/deep-nest.meridian.json`, '--json']);
    expect(a.stdout).toBe(b.stdout);
    expect(() => JSON.parse(a.stdout)).not.toThrow();
  });
});
