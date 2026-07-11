// Function declarations: plain, async, generator, exported, nested (body-lazy).
export function add(a: number, b: number): number {
  return a + b;
}

async function fetchAll(urls: string[]): Promise<string[]> {
  return urls;
}

export function* counter(start: number): Generator<number> {
  yield start;
}

function outer(): void {
  // Nested declarations are body-internal (ADR-0028 case 3): NOT eager.
  function inner(): void {}
  const cb = (): number => 0;
  void inner;
  void cb;
}
