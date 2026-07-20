import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BRIDGE_SCHEMAS } from '../src/bridge-contract.js';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const contract = resolve(repoRoot, 'contracts/bridge-v1');
const fixtures = resolve(contract, 'fixtures');
const EXPECTED_CONTRACT_SHA256 = '17fe9c731cde78b9e2e0345a49d6e4060f86fe95000929087567a8b2100be37a';

const fixtureIndexSchema = z.object({
  schema_version: z.literal(1),
  fixtures: z.array(z.object({
    path: z.string(),
    schema: z.enum([
      'graph-artifact.schema.json',
      'diff-artifact.schema.json',
      'structural-delta.schema.json',
    ]),
    valid: z.boolean(),
  })),
  support_files: z.array(z.string()),
});

function bytes(path: string): Buffer {
  return readFileSync(path);
}

function sha256(payload: Buffer): string {
  return createHash('sha256').update(payload).digest('hex');
}

function json(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function checksumManifest(path: string): Map<string, string> {
  return new Map(
    readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const [digest, name] = line.split('  ', 2);
        if (digest === undefined || name === undefined) throw new Error(`bad checksum line: ${line}`);
        return [name, digest];
      }),
  );
}

const scratch = mkdtempSync(join(tmpdir(), 'meridian-bridge-contract-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('bridge-v1 cross-repository contract', () => {
  it('pins the accepted schema and fixture tree byte identity', () => {
    const manifestPath = resolve(contract, 'SHA256SUMS');
    expect(sha256(bytes(manifestPath))).toBe(EXPECTED_CONTRACT_SHA256);
    for (const [name, digest] of checksumManifest(manifestPath)) {
      expect(sha256(bytes(resolve(contract, name))), name).toBe(digest);
    }
    for (const [name, digest] of checksumManifest(resolve(fixtures, 'SHA256SUMS'))) {
      expect(sha256(bytes(resolve(fixtures, name))), name).toBe(digest);
    }
  });

  it('accepts and rejects the exact shared corpus through the Zod structural twin', () => {
    const index = fixtureIndexSchema.parse(json(resolve(fixtures, 'fixture-index.json')));
    for (const fixture of index.fixtures) {
      const result = BRIDGE_SCHEMAS[fixture.schema].safeParse(json(resolve(fixtures, fixture.path)));
      expect(result.success, fixture.path).toBe(fixture.valid);
    }
  });

  it('accepts additive v1 fields but rejects an unknown major', () => {
    const graph = json(resolve(fixtures, 'valid-to-graph-artifact.json')) as Record<string, unknown>;
    graph.future_optional = { preserved_in_raw_evidence: true };
    expect(BRIDGE_SCHEMAS['graph-artifact.schema.json'].safeParse(graph).success).toBe(true);

    graph.schema_version = 2;
    expect(BRIDGE_SCHEMAS['graph-artifact.schema.json'].safeParse(graph).success).toBe(false);
  });

  it('makes a deliberately drifted fixture fail the recorded checksum', () => {
    const name = 'valid-to-graph-artifact.json';
    const drifted = resolve(scratch, name);
    writeFileSync(drifted, Buffer.concat([bytes(resolve(fixtures, name)), Buffer.from(' ')]));
    const recorded = checksumManifest(resolve(fixtures, 'SHA256SUMS')).get(name);
    expect(recorded).toBeDefined();
    expect(sha256(bytes(drifted))).not.toBe(recorded);
  });
});
