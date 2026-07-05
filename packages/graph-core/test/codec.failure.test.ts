/**
 * Failure suite (ROADMAP Phase 0 §12): every adversarial fixture is rejected
 * with a precise, located, typed error — never a crash, never a pass.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decode, type IssueCode } from '../src/index.js';

const invalidDir = fileURLToPath(new URL('../../../fixtures/invalid/', import.meta.url));

function decodeFixture(name: string) {
  const r = decode(readFileSync(invalidDir + name, 'utf8'));
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error('unreachable');
  return r;
}

const expectations: Array<[file: string, code: IssueCode, fragment: string]> = [
  ['dangling-edge.meridian.json', 'dangling-edge-endpoint', 'does not resolve'],
  ['cross-graph-edge.meridian.json', 'dangling-edge-endpoint', 'cross-graph edges are forbidden'],
  ['containment-cycle.meridian.json', 'containment-cycle', 'containment is a forest'],
  ['deep-cycle-10.meridian.json', 'containment-cycle', 'containment is a forest'],
  ['duplicate-id.meridian.json', 'duplicate-id', 'more than once'],
  ['shared-detail.meridian.json', 'multiple-containment', 'at most one containing node'],
  ['root-mismatch.meridian.json', 'root-mismatch', 'contained by a node'],
  ['missing-provenance.meridian.json', 'structural', ''],
  ['bad-attr-key.meridian.json', 'invalid-attr-key', 'must match ns:name'],
  ['unknown-version.meridian.json', 'unsupported-version', 'newer than this build'],
  ['missing-version.meridian.json', 'missing-format-version', 'no unversioned external surface'],
  ['malformed.json', 'malformed-json', 'not valid JSON'],
  ['truncated.meridian.json', 'malformed-json', 'not valid JSON'],
];

describe('adversarial fixtures are rejected with located, typed errors', () => {
  it.each(expectations)('%s → %s', (file, code, fragment) => {
    const r = decodeFixture(file);
    const match = r.errors.find((e) => e.code === code);
    expect(match, `expected ${code}, got: ${r.errors.map((e) => e.code).join(', ')}`).toBeDefined();
    if (fragment) expect(match!.message).toContain(fragment);
  });

  it('locates the structural error in missing-provenance precisely', () => {
    const r = decodeFixture('missing-provenance.meridian.json');
    const issue = r.errors.find((e) => e.code === 'structural');
    expect(issue?.path).toContain('provenance');
  });

  it('never throws on garbage input', () => {
    expect(decode('')).toMatchObject({ ok: false });
    expect(decode('null')).toMatchObject({ ok: false });
    expect(decode('[]')).toMatchObject({ ok: false });
    expect(decode(42)).toMatchObject({ ok: false });
    expect(decode(undefined)).toMatchObject({ ok: false });
    expect(decode({ formatVersion: 1 })).toMatchObject({ ok: false });
  });
});
