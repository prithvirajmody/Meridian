/**
 * Scale gate against a pinned real OSS repo (ROADMAP Phase 7 §11 / §12):
 * cold ingest < 30s, byte-deterministic across runs, and a compact summary
 * golden (per-kind node/edge counts + ADR-0026 resolutionRate + a SHA-256
 * digest of the canonical document) pinned to the fixture commit hash.
 *
 * The ~100k-LOC clone lives OUTSIDE the committed tree (fixtures/oss/fetch.sh
 * → fixtures/oss/clones/vue-core, gitignored; or $MERIDIAN_OSS_REPO). This
 * suite SKIPS when the clone is absent, so normal CI — which never fetches —
 * stays green. Regenerate the golden with the clone present:
 *
 *   fixtures/oss/fetch.sh
 *   UPDATE_GOLDENS=1 pnpm --filter @meridian/cli test oss-scale
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const cli = resolve(repoRoot, 'apps/cli/dist/main.js');
const goldensDir = resolve(repoRoot, 'fixtures/goldens/oss');
const UPDATE = process.env.UPDATE_GOLDENS === '1';

// The pin. The golden is bound to this exact commit of vuejs/core.
const REPO = 'vuejs/core';
const COMMIT = 'c0606e91798c8dca4f33d101e1dd836d672592c1';
const GOLDEN = 'vue-core.summary.json';

const clonePath =
  process.env.MERIDIAN_OSS_REPO ?? resolve(repoRoot, 'fixtures/oss/clones/vue-core');
const present = existsSync(clonePath);

function run(args: string[]) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: 120_000,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function sortedByKind(nodes: Array<{ kind: string }>): Record<string, number> {
  const counts = new Map<string, number>();
  for (const n of nodes) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

interface DocNode {
  kind: string;
  attrs: Record<string, unknown>;
}
interface Doc {
  roots: string[];
  graphs: Array<{ nodes: DocNode[]; edges: Array<{ kind: string }> }>;
}

/** ADR-0026 resolution rate: resolved / (resolved + unresolved), externals
 * excluded from the denominator (honestly out of scope, not failures). */
function resolutionRate(nodes: DocNode[]): { resolved: number; unresolved: number; rate: number } {
  let resolved = 0;
  let unresolved = 0;
  for (const n of nodes) {
    if (n.kind !== 'code:function' && n.kind !== 'code:method') continue;
    resolved += (n.attrs['code:calls-resolved'] as number | undefined) ?? 0;
    unresolved += (n.attrs['code:calls-unresolved'] as number | undefined) ?? 0;
  }
  const denom = resolved + unresolved;
  return { resolved, unresolved, rate: denom === 0 ? 0 : Number((resolved / denom).toFixed(4)) };
}

const suite = present ? describe : describe.skip;

suite(`OSS scale fixture — ${REPO} @ ${COMMIT.slice(0, 12)}`, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'meridian-oss-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it(
    'cold ingest < 30s, byte-deterministic, and matches the compact summary golden',
    () => {
      const docA = join(scratch, 'a.json');
      const docB = join(scratch, 'b.json');

      const started = performance.now();
      const r1 = run(['ingest', clonePath, '--out', docA]);
      const coldMs = performance.now() - started;
      expect(r1.stderr).toBe('');
      expect(r1.code).toBe(0);

      const r2 = run(['ingest', clonePath, '--out', docB]);
      expect(r2.code).toBe(0);

      const textA = readFileSync(docA, 'utf8');
      const textB = readFileSync(docB, 'utf8');

      // Byte-determinism across runs (I6 / §11).
      expect(textB).toBe(textA);

      // Cold ingest budget (§11): < 30s on this hardware.
      console.log(`[7H] cold ingest ${REPO}: ${(coldMs / 1000).toFixed(2)}s · doc ${(textA.length / 1e6).toFixed(2)}MB`);
      expect(coldMs).toBeLessThan(30_000);

      const doc = JSON.parse(textA) as Doc;
      const nodes = doc.graphs.flatMap((g) => g.nodes);
      const edges = doc.graphs.flatMap((g) => g.edges);
      const rr = resolutionRate(nodes);

      const summary = {
        repo: REPO,
        commit: COMMIT,
        adapter: 'code',
        totals: {
          graphs: doc.graphs.length,
          nodes: nodes.length,
          edges: edges.length,
          roots: doc.roots.length,
        },
        nodesByKind: sortedByKind(nodes),
        edgesByKind: sortedByKind(edges),
        callResolution: rr,
        documentSha256: sha256(textA),
      };
      const rendered = JSON.stringify(summary, null, 2) + '\n';

      const goldenPath = resolve(goldensDir, GOLDEN);
      if (UPDATE) {
        mkdirSync(goldensDir, { recursive: true });
        writeFileSync(goldenPath, rendered);
      } else {
        expect(existsSync(goldenPath), `golden missing: ${GOLDEN}`).toBe(true);
        expect(rendered).toBe(readFileSync(goldenPath, 'utf8'));
      }
    },
    120_000,
  );
});
