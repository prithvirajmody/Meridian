import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveBenchRunner } from '../src/bench.js';

describe('meridian bench composition root', () => {
  it('resolves the same repository runner used by pnpm bench', () => {
    const runner = resolveBenchRunner();
    expect(runner.endsWith('/benchmarks/run.mjs')).toBe(true);
    expect(existsSync(runner)).toBe(true);
  });
});

