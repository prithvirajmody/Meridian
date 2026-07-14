/**
 * Phase 8 CLI acceptance: `meridian ai summarize|cluster` wire the AI gateway
 * (packages/ai) and services (packages/ai-services) through the composition
 * root. The two zero-network modes (`mock`, `replay`) are exercised here with
 * no key in the environment; `live` is proven to refuse without explicit
 * consent. Output is deterministic — same input, byte-identical report.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const cli = resolve(repoRoot, 'apps/cli/dist/main.js');

/** Run the CLI with every AI key stripped from the environment, so a passing
 * mock/replay run proves it never needed the network. */
function run(args: string[]) {
  const env = { ...process.env };
  delete env['ANTHROPIC_API_KEY'];
  delete env['OPENAI_API_KEY'];
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, encoding: 'utf8', env });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status };
}

const scratch = mkdtempSync(join(tmpdir(), 'meridian-ai-'));
const doc = join(scratch, 'soup.meridian.json');
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A flat graph with two connected components → the containment-rollup base
 * yields two groups for `summarize`; every node is soup for `cluster`. */
const FIXTURE = {
  formatVersion: 1,
  producer: { name: 'ai-test', version: '0.0.0' },
  roots: ['g0'],
  graphs: [
    {
      id: 'g0',
      meta: { label: 'Root', domain: 'core', provenance: { origin: 'source' } },
      nodes: [
        { id: 'a', kind: 'core:item', label: 'Alpha', provenance: { origin: 'source' } },
        { id: 'b', kind: 'core:item', label: 'Beta', provenance: { origin: 'source' } },
        { id: 'c', kind: 'core:item', label: 'Gamma', provenance: { origin: 'source' } },
        { id: 'd', kind: 'core:item', label: 'Delta', provenance: { origin: 'source' } },
      ],
      edges: [
        { id: 'e1', src: 'a', dst: 'b', kind: 'core:link', provenance: { origin: 'source' } },
        { id: 'e2', src: 'c', dst: 'd', kind: 'core:link', provenance: { origin: 'source' } },
      ],
    },
  ],
};

beforeAll(() => {
  writeFileSync(doc, JSON.stringify(FIXTURE, null, 2), 'utf8');
});

describe('meridian ai — the fixture round-trips through the ordinary pipeline', () => {
  it('is a valid GraphDocument', () => {
    const v = run(['validate', doc]);
    expect(v.code).toBe(0);
    expect(v.stdout).toContain('OK');
  });
});

describe('meridian ai summarize (mock, zero-network)', () => {
  it('enriches the deterministic rollup groups', () => {
    const r = run(['ai', 'summarize', doc, '--json']);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      mode: string;
      enriched: number;
      floored: number;
      groups: unknown[];
    };
    expect(parsed.mode).toBe('mock');
    expect(parsed.groups.length).toBe(2);
    expect(parsed.enriched).toBe(2);
    expect(parsed.floored).toBe(0);
  });

  it('is deterministic across runs (byte-identical JSON)', () => {
    const a = run(['ai', 'summarize', doc, '--json']);
    const b = run(['ai', 'summarize', doc, '--json']);
    expect(a.code).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  });

  it('treats --budget as dollars and floors work after the dollar ceiling', () => {
    // The mock catalog is $1/MTok input + output and each call reports 20
    // tokens, so $0.00001 is crossed by the first unit and stops the second.
    const r = run(['ai', 'summarize', doc, '--json', '--budget', '0.00001']);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      stoppedByBudget: boolean;
      floored: number;
      budget: { spentDollars: number; spentTokens: number };
    };
    expect(parsed.stoppedByBudget).toBe(true);
    expect(parsed.floored).toBeGreaterThanOrEqual(1);
    expect(parsed.budget.spentDollars).toBeGreaterThan(0.00001);
    expect(parsed.budget.spentTokens).toBe(20);
  });
});

describe('meridian ai cluster (mock, zero-network)', () => {
  it('clusters the node soup from deterministic embeddings', () => {
    const r = run(['ai', 'cluster', doc, '--json']);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as { mode: string; nodes: number; clusters: unknown[] };
    expect(parsed.mode).toBe('mock');
    expect(parsed.nodes).toBe(4);
    expect(parsed.clusters.length).toBeGreaterThanOrEqual(1);
  });

  it('is deterministic across runs (byte-identical JSON)', () => {
    const a = run(['ai', 'cluster', doc, '--json']);
    const b = run(['ai', 'cluster', doc, '--json']);
    expect(a.code).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  });
});

describe('meridian ai replay (zero-network, deterministic miss)', () => {
  it('summarize with no fixtures fails with a deterministic replay miss', () => {
    const r = run(['ai', 'summarize', doc, '--ai-mode', 'replay']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('replay_miss');
  });

  it('cluster with no fixtures fails with a deterministic replay miss', () => {
    // The independent embedding route defaults to the embedding-capable
    // built-in provider (OpenAI); Anthropic remains completion-only.
    const r = run(['ai', 'cluster', doc, '--ai-mode', 'replay']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('replay_miss');
  });
});

describe('meridian ai live (consent + key gate)', () => {
  it('refuses live without --ai-consent, making no network call', () => {
    const r = run(['ai', 'summarize', doc, '--ai-mode', 'live']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--ai-consent');
  });

  it('with consent but no key, fails deterministically at the key edge', () => {
    const r = run(['ai', 'summarize', doc, '--ai-mode', 'live', '--ai-consent']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('ANTHROPIC_API_KEY');
  });
});

describe('meridian ai — parsing & flag hygiene', () => {
  it('rejects an unknown subcommand (exit 2)', () => {
    const r = run(['ai', 'frobnicate', doc]);
    expect(r.code).toBe(2);
  });

  it('does not accept the layout --provider flag (undisturbed)', () => {
    const r = run(['ai', 'summarize', doc, '--provider', 'grid']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--provider');
  });

  it('rejects an invalid --ai-mode (exit 2)', () => {
    const r = run(['ai', 'summarize', doc, '--ai-mode', 'bogus']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--ai-mode');
  });
});
