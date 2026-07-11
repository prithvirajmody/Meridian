// Binding-named functions (ADR-0028 case 1): arrow / function-expression.
export const scale = (value: number, factor: number): number => value * factor;

const helper = function (n: number): number {
  return n + 1;
};

// A plain, non-function const is not in the eager level chain — not emitted.
export const VERSION = '1.0.0';

export const compose =
  (f: (x: number) => number) =>
  (g: (x: number) => number) =>
  (x: number): number =>
    f(g(x));

void helper;
