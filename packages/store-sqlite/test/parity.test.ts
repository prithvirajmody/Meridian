/**
 * The Node binding of the 11D parity suite — the same scenario objects the
 * browser harness runs over OPFS (apps/studio/e2e/storage-parity.spec.ts).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runParityScenarios, type ParityOpenOptions, type ParitySession, type ParityStack } from '../src/index.js';
import { openProjectStore } from '../src/node/index.js';

function nodeStack(): ParityStack & { dispose(): void } {
  let dir = mkdtempSync(join(tmpdir(), 'meridian-parity-'));
  return {
    async reset(): Promise<void> {
      rmSync(dir, { recursive: true, force: true });
      dir = mkdtempSync(join(tmpdir(), 'meridian-parity-'));
    },
    async open(opts: ParityOpenOptions = {}): Promise<ParitySession> {
      const { project, store, hydration } = await openProjectStore(join(dir, 'parity.meridian'), opts);
      return {
        space: project.space,
        version: project.version,
        replayedDeltas: project.replayedDeltas,
        ...(project.manifest ? { manifest: project.manifest } : {}),
        store,
        ...(hydration ? { hydration } : {}),
        flush: () => project.flush(),
        close: () => project.close(),
        async abandon(): Promise<void> {
          // Let the queued post-commit appends land, then walk away without
          // the closing checkpoint — the connection is deliberately leaked,
          // exactly what a dying process does.
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        },
      };
    },
    dispose(): void {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('runtime parity suite (Node binding)', () => {
  it('every shared scenario passes against better-sqlite3', async () => {
    const stack = nodeStack();
    try {
      const outcomes = await runParityScenarios(stack);
      const failed = outcomes.filter((o) => !o.ok);
      expect(failed, failed.map((f) => `${f.name}: ${f.detail}`).join('\n\n')).toEqual([]);
      expect(outcomes.length).toBeGreaterThanOrEqual(6);
    } finally {
      stack.dispose();
    }
  });
});
