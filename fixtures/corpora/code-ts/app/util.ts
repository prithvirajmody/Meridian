// 7E fixture — local calls, higher-order, and dynamic dispatch.
export function add(a: number, b: number): number {
  return a + b;
}

// A same-module (tier 1) call: `add` binds to the local declaration above.
export function twice(n: number): number {
  return add(n, n);
}

// A dynamic call: the callee is a subscript expression, not an identifier —
// stays unresolved (ADR-0026 tier 3), and is counted.
export function first(fns: Array<() => number>): number {
  return fns[0]!();
}
