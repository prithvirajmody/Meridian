/**
 * TypeScript import & call edges — hand-drawn truth (7E, ADR-0026; ROADMAP §12
 * Unit/Integration rows). Each inline bundle pins a construct to the exact
 * edges and counters it must produce: import resolution (relative + index +
 * extension swap + bare/external), the three call tiers, unresolved honesty
 * (member/dynamic/ambiguous/external), weight collapsing with sampled spans,
 * the confidence attr, and byte-determinism with edges present.
 */
import { encodeCanonical } from '@meridian/graph-core';
import { afterAll, describe, expect, it } from 'vitest';
import type { CodeMapper } from '../src/index.js';
import { ingestBundle } from './edge-support.js';
import { inProcessMapper } from './support.js';

const mapper: CodeMapper = inProcessMapper();
afterAll(() => mapper.dispose());

describe('TypeScript — code:imports edges (lexical resolution)', () => {
  it('relative specifiers resolve by extension, index, and .js→.ts swap; bare is external', async () => {
    const ing = await ingestBundle(mapper, [
      {
        path: 'main.ts',
        text: [
          "import { add } from './util';", // → util.ts (extension)
          "import def from './util.js';", // → util.ts (.js→.ts swap), default
          "import { helper } from './lib/helpers';", // → lib/helpers.ts
          "import { root } from './pkg';", // → pkg/index.ts (index rule)
          "import React from 'react';", // bare → external, no edge
          'export function run(): number { return add(1, 2) + def() + helper() + root(); }',
        ].join('\n'),
      },
      { path: 'util.ts', text: 'export function add(a: number, b: number): number { return a + b; }\nexport default function def(): number { return 0; }' },
      { path: 'lib/helpers.ts', text: 'export function helper(): number { return 1; }' },
      { path: 'pkg/index.ts', text: 'export function root(): number { return 2; }' },
    ]);

    // Same-directory import → a module→module edge; two statements to util → weight 2.
    const toUtil = ing.edgesBetween('code:imports', 'main.ts', 'util.ts');
    expect(toUtil).toHaveLength(1);
    expect(toUtil[0]!.weight).toBe(2);
    expect(toUtil[0]!.attrs['code:confidence']).toBe('syntactic');

    // Cross-directory imports resolve, then re-base at the package (portal rule).
    expect(ing.edgesBetween('code:imports', 'main.ts', 'lib')).toHaveLength(1); // ./lib/helpers → lib/helpers.ts
    expect(ing.edgesBetween('code:imports', 'main.ts', 'pkg')).toHaveLength(1); // ./pkg → pkg/index.ts

    // A bare specifier resolving to no ingested file is external — counted, no edge.
    expect(ing.edges.some((e) => e.kind === 'code:imports' && ing.label(e.dst) === 'react')).toBe(false);
    expect(ing.nodeByLabel('main.ts').attrs['code:imports-external']).toBe(1);
  });

  it('re-exports create code:imports edges but no declaration nodes (ADR-0028 case 6)', async () => {
    const ing = await ingestBundle(mapper, [
      { path: 'barrel.ts', text: "export { add } from './provider';\nexport * from './models';" },
      { path: 'provider.ts', text: 'export function add(a: number, b: number): number { return a + b; }' },
      { path: 'models.ts', text: 'export class Box {}' },
    ]);
    expect(ing.edgesBetween('code:imports', 'barrel.ts', 'provider.ts')).toHaveLength(1);
    expect(ing.edgesBetween('code:imports', 'barrel.ts', 'models.ts')).toHaveLength(1);
    // The barrel adds no declarations of its own.
    expect(ing.nodeByLabel('barrel.ts').detail).toBeUndefined();
  });
});

describe('TypeScript — code:calls edges (the three tiers)', () => {
  const bundle = [
    {
      path: 'provider.ts',
      text: [
        'export function add(a: number, b: number): number { return a + b; }',
        'export function twice(n: number): number { return add(n, n); }', // tier 1: local
      ].join('\n'),
    },
    {
      path: 'consumer.ts',
      text: [
        "import { add, twice } from './provider';",
        "import { readFileSync } from 'node:fs';",
        'export function compute(a: number, b: number): number {',
        '  const s = add(a, b);',
        '  return twice(s) + twice(s);', // twice ×2 → weight 2
        '}',
        'export function loadit(p: string): string { return readFileSync(p, "utf8"); }', // external
        'export function hof(fn: () => number): number { return fn(); }', // param → unresolved
      ].join('\n'),
    },
    {
      path: 'models.ts',
      text: [
        'export class Box {',
        '  private value = 0;',
        '  get(): number { return this.value; }',
        '  doubled(): number { return this.get() + this.get(); }', // self ×2 → weight 2
        '}',
        'export function pick(): number;',
        'export function pick(x: number): number;',
        'export function pick(x?: number): number { return x ?? 0; }',
        'export function chooser(): number { return pick(); }', // ambiguous → unresolved
        'export function dyn(a: Array<() => number>): number { return a[0]!(); }', // dynamic → unresolved
      ].join('\n'),
    },
  ];

  it('tier 1: a same-module call is a function→function edge, confidence syntactic', async () => {
    const ing = await ingestBundle(mapper, bundle);
    const e = ing.edgesBetween('code:calls', 'twice', 'add');
    expect(e).toHaveLength(1);
    expect(e[0]!.weight).toBe(1);
    expect(e[0]!.attrs['code:confidence']).toBe('syntactic');
    expect(ing.countersOf('twice')).toEqual([{ resolved: 1, unresolved: 0, external: 0 }]);
  });

  it('tier 1 self: repeated this.method() collapses to ONE edge, weight = count, ≤3 sampled spans', async () => {
    const ing = await ingestBundle(mapper, bundle);
    const e = ing.edgesBetween('code:calls', 'doubled', 'get');
    expect(e).toHaveLength(1);
    expect(e[0]!.weight).toBe(2);
    expect((e[0]!.attrs['code:call-sites'] as string).split(',')).toHaveLength(2);
    expect(ing.countersOf('doubled')).toEqual([{ resolved: 2, unresolved: 0, external: 0 }]);
  });

  it('tier 2: import-bound calls re-base to a module→module edge; weight aggregates', async () => {
    const ing = await ingestBundle(mapper, bundle);
    // compute → add + twice + twice, all import-bound to provider.ts.
    const e = ing.edgesBetween('code:calls', 'consumer.ts', 'provider.ts');
    expect(e).toHaveLength(1);
    expect(e[0]!.weight).toBe(3);
    expect((e[0]!.attrs['code:call-sites'] as string).split(',')).toHaveLength(3); // sampled, capped at 3
    expect(ing.countersOf('compute')).toEqual([{ resolved: 3, unresolved: 0, external: 0 }]);
  });

  it('tier 3 honesty: external / dynamic / higher-order / ambiguous stay unresolved, no edge', async () => {
    const ing = await ingestBundle(mapper, bundle);
    // External: import-bound to node:fs (not ingested) → external counter, no edge.
    expect(ing.countersOf('loadit')).toEqual([{ resolved: 0, unresolved: 0, external: 1 }]);
    expect(ing.edges.some((e) => e.kind === 'code:calls' && ing.label(e.dst) === 'readFileSync')).toBe(false);
    // Higher-order (param), dynamic (subscript callee), ambiguous overload — all unresolved.
    expect(ing.countersOf('hof')).toEqual([{ resolved: 0, unresolved: 1, external: 0 }]);
    expect(ing.countersOf('dyn')).toEqual([{ resolved: 0, unresolved: 1, external: 0 }]);
    expect(ing.countersOf('chooser')).toEqual([{ resolved: 0, unresolved: 1, external: 0 }]);
    // A name with > 1 candidate is never arbitrarily picked → no pick() call edge.
    expect(ing.edges.some((e) => e.kind === 'code:calls' && ing.label(e.dst) === 'pick')).toBe(false);
  });

  it('every emitted edge carries confidence:syntactic and ingest is byte-deterministic', async () => {
    const a = await ingestBundle(mapper, bundle);
    for (const e of a.edges) expect(e.attrs['code:confidence']).toBe('syntactic');
    expect(a.edges.length).toBeGreaterThan(0);
    const b = await ingestBundle(mapper, bundle);
    expect(encodeCanonical(b.space)).toBe(encodeCanonical(a.space));
  });
});

describe('TypeScript — cross-package calls induce via the portal rule', () => {
  it('a call into another package re-bases to a package→package edge', async () => {
    const ing = await ingestBundle(mapper, [
      { path: 'app/service.ts', text: "import { dot } from '../geo/vectors';\nexport function magnitude(): number { return dot(); }" },
      { path: 'geo/vectors.ts', text: 'export function dot(): number { return 0; }' },
    ]);
    // service.ts (app) → dot (geo) has no shared graph; the lowest common graph
    // is the project, so the base edge joins the sibling packages there.
    expect(ing.edgesBetween('code:calls', 'app', 'geo')).toHaveLength(1);
    expect(ing.countersOf('magnitude')).toEqual([{ resolved: 1, unresolved: 0, external: 0 }]);
  });
});
