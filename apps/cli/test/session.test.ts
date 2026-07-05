/**
 * The 20-step editing session, end to end through the real CLI (ROADMAP
 * Phase 1 §12 integration + manual-exploratory rows, DoD "undo/redo
 * demonstrably works via invertDelta in a CLI session"):
 *
 *   mutate original --script session --out after --emit-delta d
 *   invert d > undo
 *   mutate after --script undo --out restored
 *   restored ≡ original (byte-identical modulo producer)
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, encodePretty } from '@meridian/graph-core';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const cli = resolve(repoRoot, 'apps/cli/dist/main.js');
const original = resolve(repoRoot, 'fixtures/valid/deep-nest.meridian.json');
const sessionScript = resolve(repoRoot, 'fixtures/scripts/session.json');
const CLI_PRODUCER = { name: '@meridian/cli', version: '0.1.0' };

function run(args: string[]) {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, encoding: 'utf8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status };
}

const dir = mkdtempSync(join(tmpdir(), 'meridian-session-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('20-step session with full undo via inverted deltas', () => {
  const after = join(dir, 'after.json');
  const emitted = join(dir, 'd.json');
  const undoScript = join(dir, 'undo.json');
  const restored = join(dir, 'restored.json');

  it('applies the session and emits the completed delta', () => {
    const r = run(['mutate', original, '--script', sessionScript, '--out', after, '--emit-delta', emitted]);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    const delta = JSON.parse(readFileSync(emitted, 'utf8')) as { ops: unknown[] };
    expect(delta.ops).toHaveLength(20);
    // The mutated document differs from the original.
    const a = decode(readFileSync(original, 'utf8'));
    const b = decode(readFileSync(after, 'utf8'));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(encodePretty(b.space)).not.toBe(encodePretty(a.space));
  });

  it('inverts the emitted delta and restores the original, byte for byte', () => {
    const inv = run(['invert', emitted]);
    expect(inv.code).toBe(0);
    writeFileSync(undoScript, inv.stdout);
    const r = run(['mutate', after, '--script', undoScript, '--out', restored]);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    const orig = decode(readFileSync(original, 'utf8'));
    expect(orig.ok).toBe(true);
    if (!orig.ok) return;
    const reference = encodePretty(orig.space, { producer: CLI_PRODUCER });
    expect(readFileSync(restored, 'utf8')).toBe(reference);
  });

  it('the inverse of the inverse replays the session (redo)', () => {
    const redo = run(['invert', undoScript]);
    expect(redo.code).toBe(0); // an inverse is itself a completed portable delta
    const redoScript = join(dir, 'redo.json');
    const redone = join(dir, 'redone.json');
    writeFileSync(redoScript, redo.stdout);
    const r = run(['mutate', original, '--script', redoScript, '--out', redone]);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(readFileSync(redone, 'utf8')).toBe(readFileSync(after, 'utf8'));
  });
});
