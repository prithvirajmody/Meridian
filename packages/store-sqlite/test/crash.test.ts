/**
 * kill -9 mid-write → reopen recovers to a consistent version via op-log
 * replay (ROADMAP Phase 11 §11; ADR-0038 §5). The child commits numbered
 * graphs with checkpointEvery=4; SIGKILL lands at an arbitrary protocol
 * point; the invariant is exact-prefix consistency: the reopened project
 * holds graphs 0..K-1 iff its durable version counter is K.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openProject } from '../src/node/index.js';
import { gid, tmpProjectPath } from './helpers.js';

const CHILD = join(import.meta.dirname, 'crash-child.mjs');

function runChildAndKill(path: string, killAfterMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, path], { stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (chunk.includes('started')) {
        setTimeout(() => child.kill('SIGKILL'), killAfterMs);
      }
    });
    child.on('exit', (code, signal) => {
      if (signal === 'SIGKILL') resolve();
      else reject(new Error(`child exited ${code}/${signal} without being killed — increase the workload`));
    });
    child.on('error', reject);
  });
}

describe('kill -9 crash recovery', () => {
  it.each([15, 60, 140])('recovers to an exact committed prefix (kill after %dms)', async (killAfterMs) => {
    const path = tmpProjectPath();
    // Seed the file so the child opens an existing project.
    const seed = await openProject(path);
    await seed.close();

    await runChildAndKill(path, killAfterMs);

    const reopened = await openProject(path);
    const k = reopened.version.counter;
    expect(k).toBeGreaterThanOrEqual(0);
    expect(reopened.space.graphs.size).toBe(k);
    for (let i = 0; i < k; i++) {
      expect(reopened.space.graphs.get(gid(`g-crash-${i}`)), `graph ${i} of prefix ${k}`).toBeDefined();
    }
    // The recovery finished the checkpoint: a second open replays nothing
    // and sees the identical prefix.
    await reopened.close();
    const again = await openProject(path);
    expect(again.replayedDeltas).toBe(0);
    expect(again.version.counter).toBe(k);
    expect(again.space.graphs.size).toBe(k);
    await again.close();
  });
});
