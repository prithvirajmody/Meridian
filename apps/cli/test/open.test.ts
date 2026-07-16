/**
 * `meridian open` end to end through the real CLI (ROADMAP Phase 11 §6,
 * SUBPHASES 11B): create-from-import + export round-trip, durable --mutate
 * (version seed survives reopen), the ADR-0038 corruption exits
 * (`storage-corrupt`, `storage-not-a-project`), and --salvage producing a
 * decodable document.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, encodeCanonical, stats } from '@meridian/graph-core';
import { BetterSqlite3Driver } from '@meridian/store-sqlite/node';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const cli = resolve(repoRoot, 'apps/cli/dist/main.js');
const original = resolve(repoRoot, 'fixtures/valid/deep-nest.meridian.json');

function run(args: string[]) {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, encoding: 'utf8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status };
}

const dir = mkdtempSync(join(tmpdir(), 'meridian-open-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Structural space equality as the invariants mean it: canonical wire form. */
const PRODUCER = { name: 'test', version: '0' };

describe('open --import / --export round-trip', () => {
  const project = join(dir, 'new.meridian');
  const exported = join(dir, 'exported.meridian.json');

  it('creates a project from a document import', () => {
    const r = run(['open', project, '--import', original]);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('open ok');
    expect(r.stdout).toContain(`imported ${original}`);
  });

  it('exports a document structurally identical to the imported one', () => {
    const r = run(['open', project, '--export', exported]);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    const a = decode(readFileSync(original, 'utf8'));
    const b = decode(readFileSync(exported, 'utf8'));
    expect(a.ok).toBe(true);
    expect(b.ok, !b.ok ? 'exported document failed to decode' : '').toBe(true);
    if (!a.ok || !b.ok) return;
    expect(stats(b.space)).toEqual(stats(a.space));
    expect(encodeCanonical(b.space, { producer: PRODUCER })).toBe(
      encodeCanonical(a.space, { producer: PRODUCER }),
    );
  });
});

describe('open --mutate applies durably', () => {
  const project = join(dir, 'mutate.meridian');
  const script = join(dir, 'add-graph.json');
  writeFileSync(
    script,
    JSON.stringify({
      origin: { actor: 'test' },
      ops: [
        {
          t: 'graph:add',
          graph: 'g-open-test',
          meta: { label: 'Open test', domain: 'demo', provenance: { origin: 'source', uri: 'test://open' } },
        },
      ],
    }),
  );

  it('creates an empty project at v0 with zero graphs', () => {
    const r = run(['open', project, '--json']);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout) as { version: { counter: number }; stats: { graphs: number } };
    expect(j.version.counter).toBe(0);
    expect(j.stats.graphs).toBe(0);
  });

  it('applies the delta script with exit 0', () => {
    const r = run(['open', project, '--mutate', script]);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
  });

  it('a plain reopen sees the incremented stats and the durable version seed', () => {
    const r = run(['open', project, '--json']);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout) as { version: { counter: number }; stats: { graphs: number } };
    expect(j.stats.graphs).toBe(1);
    expect(j.version.counter).toBe(1);
  });
});

describe('corruption exits (ADR-0038 §6)', () => {
  it('a garbage file exits 1 with storage-corrupt on stderr', () => {
    const garbage = join(dir, 'garbage.meridian');
    writeFileSync(garbage, 'this is definitely not a SQLite database\n'.repeat(32));
    const r = run(['open', garbage]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('storage-corrupt');
    expect(r.stdout).toBe('');
  });

  it('--salvage on a healthy project exits 0 and writes a decodable document', () => {
    const project = join(dir, 'healthy.meridian');
    expect(run(['open', project, '--import', original]).code).toBe(0);
    const out = join(dir, 'salvaged.meridian.json');
    const r = run(['open', project, '--salvage', out]);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    const salvaged = decode(readFileSync(out, 'utf8'));
    expect(salvaged.ok, !salvaged.ok ? 'salvaged document failed to decode' : '').toBe(true);
    const orig = decode(readFileSync(original, 'utf8'));
    if (!salvaged.ok || !orig.ok) return;
    expect(stats(salvaged.space)).toEqual(stats(orig.space));
  });

  it('a valid SQLite db that is not a Meridian project exits 1 with storage-not-a-project', () => {
    const alien = join(dir, 'alien.meridian');
    const db = new BetterSqlite3Driver(alien);
    try {
      db.exec('CREATE TABLE cats (name TEXT)');
      db.run('INSERT INTO cats (name) VALUES (?)', ['mog']);
    } finally {
      db.close();
    }
    const r = run(['open', alien]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('storage-not-a-project');
    expect(r.stdout).toBe('');
  });
});
