/**
 * Architecture verification (7C, ROADMAP §12 Architecture row): the core and
 * abstraction packages carry **no code-domain vocabulary** in their logic —
 * domain knowledge lives only in this adapter (§20). We strip comments before
 * scanning, because graph-core's model doc-comment legitimately *illustrates*
 * namespaced kinds with `'code:function'`; the invariant is that no code kind
 * appears as real code. ("grammars only load in workers" is exercised
 * behaviorally in worker-map.test.ts, where the worker actually loads a grammar
 * and returns a mapped module.)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');

/** Packages that must never know a code kind (the dependency-law core, §20). */
const DOMAIN_FREE_PACKAGES = [
  'packages/graph-core',
  'packages/graph-store',
  'packages/abstraction',
  'packages/plugin-api',
  'packages/plugin-host',
  'packages/conformance-kit',
  'packages/view-model',
  'packages/layout',
  'packages/renderer',
];

const CODE_KIND =
  /code:(project|package|module|class|function|method|namespace|imports|calls|contains|block|stmt|expr|flows-to)/;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('architecture — code vocabulary is adapter-local', () => {
  for (const pkg of DOMAIN_FREE_PACKAGES) {
    it(`${pkg}/src contains no code-domain kind in real code`, () => {
      const offenders: string[] = [];
      for (const file of tsFiles(resolve(repoRoot, pkg, 'src'))) {
        const code = stripComments(readFileSync(file, 'utf8'));
        if (CODE_KIND.test(code)) offenders.push(file.replace(repoRoot + '/', ''));
      }
      expect(offenders).toEqual([]);
    });
  }
});
