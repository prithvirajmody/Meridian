/**
 * `meridian watch <repo>` end to end through the real CLI (Phase 7G): a scripted
 * edit sequence against a fixture directory produces streamed, minimal code
 * deltas — the whitespace edit is a no-op, a single-declaration edit is one
 * op — and a live save is picked up by the `fs.watch` follower.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const cli = resolve(repoRoot, 'apps/cli/dist/main.js');

function run(args: string[]) {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, encoding: 'utf8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status };
}

const dir = mkdtempSync(join(tmpdir(), 'meridian-watch-repo-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const V0 = `export function add(a: number, b: number): number {
  return a + b;
}
`;
const V_WS = '\n' + V0; // whitespace-only
const V_RET = V_WS.replace(': number {', ': Big {'); // one-declaration edit

describe('meridian watch <repo> — scripted edits (--edits)', () => {
  it('streams minimal deltas: whitespace ⇒ no-op, return-type ⇒ one op', () => {
    const repo = mkdtempSync(join(dir, 'repo-'));
    writeFileSync(join(repo, 'add.ts'), V0);
    const script = join(dir, 'edits.json');
    writeFileSync(
      script,
      JSON.stringify([
        { path: 'add.ts', newText: V_WS },
        { path: 'add.ts', newText: V_RET },
        { path: 'extra.ts', newText: 'export function e(): void {}\n' },
        { path: 'extra.ts', delete: true },
      ]),
    );

    const r = run(['watch', repo, '--edits', script]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('watching');
    // Whitespace edit committed nothing.
    expect(r.stdout).toContain('add.ts: no semantic change (empty delta)');
    // The return-type edit is exactly one node:attr op on the changed graph.
    expect(r.stdout).toMatch(/node:attr 1/);
    expect(r.stdout).toContain('code:returns');
    // File add then delete round-trips through the store.
    expect(r.stdout).toMatch(/node:add/);
    expect(r.stdout).toMatch(/(node:remove|graph:remove)/);
    expect(r.stdout).toContain('done:');
  });

  it('--json emits one change-event object per committed edit', () => {
    const repo = mkdtempSync(join(dir, 'repo-json-'));
    writeFileSync(join(repo, 'm.ts'), V0);
    const script = join(dir, 'edits-json.json');
    writeFileSync(script, JSON.stringify([{ path: 'm.ts', newText: V_RET }]));
    const r = run(['watch', repo, '--edits', script, '--json']);
    expect(r.code, r.stderr).toBe(0);
    const jsonLine = r.stdout.split('\n').find((l) => l.trim().startsWith('{'));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!) as { delta: { ops: unknown[] } };
    expect(parsed.delta.ops.length).toBe(1);
  });
});

describe('meridian watch <repo> — live follow (fs.watch)', () => {
  it('picks up a real file save and emits a delta', async () => {
    const repo = mkdtempSync(join(dir, 'repo-live-'));
    writeFileSync(join(repo, 'live.ts'), V0);
    const child = spawn(process.execPath, [cli, 'watch', repo], { cwd: repoRoot });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (stdout += d));

    const waitFor = (needle: string, ms: number): Promise<boolean> =>
      new Promise((res) => {
        const t0 = Date.now();
        const tick = (): void => {
          if (stdout.includes(needle)) return res(true);
          if (Date.now() - t0 > ms) return res(false);
          setTimeout(tick, 25);
        };
        tick();
      });

    try {
      expect(await waitFor('watching', 8000)).toBe(true);
      // A real save: change add()'s return type.
      writeFileSync(join(repo, 'live.ts'), V0.replace(': number {', ': Live {'));
      expect(await waitFor('code:returns', 8000)).toBe(true);
    } finally {
      child.kill('SIGINT');
    }
  }, 20000);
});
