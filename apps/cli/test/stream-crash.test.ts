/**
 * SIGKILL during stageDeltaStream + real SQLite backend: reopen must recover an
 * exact durable prefix, then checkpoint it so the next open replays nothing.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openProject } from '@meridian/store-sqlite/node';
import { afterEach, describe, expect, it } from 'vitest';

const CHILD = join(import.meta.dirname, 'stream-crash-child.mjs');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function killDuringStream(path: string, delayMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, path], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    let started = false;
    let scheduled = false;
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.on('message', (raw: unknown) => {
      const message = raw as { type?: string; count?: number };
      if (message.type === 'started') started = true;
      if (!scheduled && message.type === 'append' && (message.count ?? 0) >= 4) {
        scheduled = true;
        setTimeout(() => child.kill('SIGKILL'), delayMs);
      }
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      clearTimeout(watchdog);
      if (!started) reject(new Error('stream crash child never became ready'));
      else if (!scheduled) reject(new Error('stream crash child never entered backend append'));
      else if (signal !== 'SIGKILL') reject(new Error(`stream crash child exited ${code}/${signal}`));
      else resolve();
    });
  });
}

describe('streamed ingest SIGKILL recovery', () => {
  it.each([0, 5])('recovers an exact staged prefix (kill delay %dms)', async (delayMs) => {
    const root = mkdtempSync(join(tmpdir(), 'meridian-stream-crash-'));
    roots.push(root);
    const path = join(root, 'project.meridian');
    const seed = await openProject(path);
    await seed.close();

    await killDuringStream(path, delayMs);

    const recovered = await openProject(path);
    const committed = recovered.version.counter;
    expect(committed).toBeGreaterThan(0);
    expect(recovered.space.graphs.size).toBe(committed);
    for (let index = 0; index < committed; index++) {
      expect(recovered.space.graphs.has(`g-stream-crash-${index}` as never)).toBe(true);
    }
    await recovered.close();

    const stable = await openProject(path);
    expect(stable.replayedDeltas).toBe(0);
    expect(stable.version.counter).toBe(committed);
    expect(stable.space.graphs.size).toBe(committed);
    await stable.close();
  });
});
