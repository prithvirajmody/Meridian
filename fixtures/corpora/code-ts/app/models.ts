// 7E fixture — this.method() (tier 1 self) and an overloaded, ambiguous callee.
export class Box {
  private value: number;

  constructor(v: number) {
    this.value = v;
  }

  get(): number {
    return this.value;
  }

  // Two `this.get()` call-sites collapse to ONE code:calls edge, weight 2.
  doubled(): number {
    return this.get() + this.get();
  }
}

// An overloaded name: more than one syntactic binding candidate.
export function pick(): number;
export function pick(x: number): number;
export function pick(x?: number): number {
  return x ?? 0;
}

// `pick()` has > 1 candidate binding (the overloads) → unresolved, never picked.
export function chooser(): number {
  return pick();
}
