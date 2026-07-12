// 7E fixture — cross-module imports (same package + another package) + external.
import { add, twice } from './util';
import { dot, Vector } from '../geometry/vectors';
import { readFileSync } from 'node:fs';

// Import-bound (tier 2) calls: `add` and `twice` resolve to ./util's exports;
// the two `twice` call-sites collapse to one edge, weight 2.
export function compute(a: number, b: number): number {
  const s = add(a, b);
  return twice(s) + twice(s);
}

// A cross-package import-bound call: resolves to geometry/vectors' `dot`. In a
// module cut this induces to a package-level edge (portal rule).
export function magnitude(v: Vector): number {
  return dot(v, v);
}

// An external call: `readFileSync` is import-bound to `node:fs`, which is not an
// ingested module → counted in code:calls-external, no edge.
export function load(path: string): string {
  return readFileSync(path, 'utf8');
}

// A higher-order call: `fn` is a parameter, not a declaration → unresolved.
export function apply(fn: (n: number) => number, n: number): number {
  return fn(n);
}
