import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const contract = resolve(repoRoot, 'contracts/org-v1');
const fixtures = resolve(contract, 'fixtures');
const orgFixtures = resolve(fixtures, 'org');
const runEventFixtures = resolve(fixtures, 'org-run-events');
const EXPECTED_CONTRACT_SHA256 = '8adc8e0be710f68456ded17294b9690ab5f1917e7014e10b91a881064c0d17e8';

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

function jsonFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return jsonFiles(path);
    return entry.name.endsWith('.json') ? [path] : [];
  });
}

const scratch = mkdtempSync(join(tmpdir(), 'meridian-org-contract-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// This 14b slice checks bytes, manifests, and JSON syntax only. Semantic schema
// validation through Zod structural twins belongs to the approved adapter slice.
describe('org-v1 cross-repository contract', () => {
  it('pins the accepted schema and fixture trees byte identity', () => {
    const manifestPath = resolve(contract, 'SHA256SUMS');
    expect(sha256(bytes(manifestPath))).toBe(EXPECTED_CONTRACT_SHA256);
    for (const [name, digest] of checksumManifest(manifestPath)) {
      expect(sha256(bytes(resolve(contract, name))), name).toBe(digest);
    }
    for (const fixtureRoot of [orgFixtures, runEventFixtures]) {
      for (const [name, digest] of checksumManifest(resolve(fixtureRoot, 'SHA256SUMS'))) {
        expect(sha256(bytes(resolve(fixtureRoot, name))), name).toBe(digest);
      }
    }
  });

  it('parses every fixture as JSON', () => {
    for (const fixtureRoot of [orgFixtures, runEventFixtures]) {
      for (const path of jsonFiles(fixtureRoot)) {
        expect(() => json(path), relative(contract, path)).not.toThrow();
      }
    }
  });

  it('makes a deliberately drifted fixture fail the recorded checksum', () => {
    const name = 'valid-minimal.json';
    const drifted = resolve(scratch, name);
    writeFileSync(drifted, Buffer.concat([bytes(resolve(orgFixtures, name)), Buffer.from(' ')]));
    const recorded = checksumManifest(resolve(orgFixtures, 'SHA256SUMS')).get(name);
    expect(recorded).toBeDefined();
    expect(sha256(bytes(drifted))).not.toBe(recorded);
  });
});
