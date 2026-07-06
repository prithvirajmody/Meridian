/**
 * Proposals applied through the real store (ROADMAP Phase 3 §12, Integration
 * row). End-to-end across real package boundaries, no sibling mocked:
 * a deterministic `AbstractionProvider` (abstraction) proposes grouping over a
 * flat graph → `applyProposal` turns it into ordinary op-based deltas through
 * a real `GraphStore`'s one write path (graph-store) → the snapshot is encoded
 * (graph-core) to disk → the **CLI** `meridian cut` resolves it, and the cut
 * reflects the new containment: the groups are the coarse view, the members
 * the fine one.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  containmentRollupProvider,
  type AbstractionProposal,
  applyProposal,
} from '@meridian/abstraction';
import {
  addEdge,
  addGraph,
  addNode,
  asEdgeId,
  asGraphId,
  asNodeId,
  encode,
  encodePretty,
  createGraphSpace,
  type GraphSpace,
  type SourceRef,
} from '@meridian/graph-core';
import { createStore } from '@meridian/graph-store';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const cli = resolve(repoRoot, 'apps/cli/dist/main.js');

function run(args: string[]) {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, encoding: 'utf8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status };
}

const scratch = mkdtempSync(join(tmpdir(), 'meridian-proposal-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const SRC: SourceRef = { origin: 'source', uri: 'test://proposal-cut' };
const G = asGraphId('g-root');

/** A flat 5-node graph with two connected components: {a,b,c} and {d,e}. */
function flatSpace(): GraphSpace {
  let s = addGraph(createGraphSpace(), { id: G, label: 'soup', domain: 'demo', provenance: SRC });
  for (const n of ['n-a', 'n-b', 'n-c', 'n-d', 'n-e']) {
    s = addNode(s, G, { id: asNodeId(n), kind: 'demo:item', label: n.slice(2), provenance: SRC });
  }
  for (const [eid, a, b] of [
    ['e-ab', 'n-a', 'n-b'],
    ['e-bc', 'n-b', 'n-c'],
    ['e-de', 'n-d', 'n-e'],
  ] as const) {
    s = addEdge(s, G, { id: asEdgeId(eid), src: asNodeId(a), dst: asNodeId(b), kind: 'demo:rel', provenance: SRC });
  }
  return s;
}

interface CutJson {
  level: number;
  maxLevel: number;
  coverage: { leaves: number; coveredLeaves: number; covers: boolean };
  cut: { id: string; label: string; kind: string; reason: string; coveredLeaves: number }[];
}

function cutAt(file: string, level: number): CutJson {
  const r = run(['cut', file, '--level', String(level), '--json']);
  expect(r.stderr).toBe('');
  expect(r.code).toBe(0);
  return JSON.parse(r.stdout) as CutJson;
}

describe('deterministic provider → applyProposal → real GraphStore → meridian cut', () => {
  it('the grouping proposed by the provider is visible in a subsequent cut', async () => {
    const before = flatSpace();
    const store = createStore(before);

    // Before: the flat graph has one level; the cut is the 5 nodes.
    const beforeFile = join(scratch, 'before.meridian.json');
    writeFileSync(beforeFile, encodePretty(store.snapshot()), 'utf8');
    const flat = cutAt(beforeFile, 0);
    expect(flat.cut.map((m) => m.label).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(flat.maxLevel).toBe(0);

    // The deterministic provider proposes one group per connected component.
    const proposal: AbstractionProposal = await containmentRollupProvider.propose(
      encode(store.snapshot()),
      { apiVersion: '0.1.0', log: { info: () => undefined, warn: () => undefined } },
    );
    expect(proposal.groups).toHaveLength(2);
    expect(proposal.groups.map((g) => g.members.length).sort()).toEqual([2, 3]);

    // Applied through the store's ONE write path: an ordinary, invertible delta.
    const applied = applyProposal(store, proposal);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.delta.ops.length).toBeGreaterThan(0);
    expect(applied.delta.origin.actor).toBe('core:abstraction');

    // After: encode the new snapshot and cut it through the CLI.
    const afterFile = join(scratch, 'after.meridian.json');
    writeFileSync(afterFile, encodePretty(store.snapshot()), 'utf8');
    expect(run(['validate', afterFile]).code).toBe(0);

    // Level 0 (coarse): exactly the two cluster nodes, covering all 5 leaves.
    const coarse = cutAt(afterFile, 0);
    expect(coarse.maxLevel).toBe(1);
    expect(coarse.cut).toHaveLength(2);
    expect(coarse.cut.every((m) => m.kind === 'core:cluster')).toBe(true);
    expect(coarse.cut.map((m) => m.coveredLeaves).sort()).toEqual([2, 3]);
    expect(coarse.coverage).toEqual({ leaves: 5, coveredLeaves: 5, covers: true });

    // Level 1 (fine): the original members, still a covering cut.
    const fine = cutAt(afterFile, 1);
    expect(fine.cut.map((m) => m.label).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(fine.coverage.covers).toBe(true);
  });

  it('applying the same proposal twice is refused (id collision), store untouched', async () => {
    const store = createStore(flatSpace());
    const proposal = await containmentRollupProvider.propose(encode(store.snapshot()), {
      apiVersion: '0.1.0',
      log: { info: () => undefined, warn: () => undefined },
    });
    expect(applyProposal(store, proposal).ok).toBe(true);
    const versionAfterFirst = store.version();

    const again = applyProposal(store, proposal);
    expect(again.ok).toBe(false);
    if (!again.ok) {
      // The group node ids already exist; refused with located errors, no write.
      expect(again.errors.every((e) => e.code === 'id-collision' || e.code === 'unknown-member')).toBe(true);
    }
    expect(store.version()).toEqual(versionAfterFirst);
  });
});
