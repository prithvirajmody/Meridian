// Overloaded signatures (ADR-0028 case 2): #signatureHash discriminators.
export function parse(input: string): object;
export function parse(input: number): object;
export function parse(input: boolean): object;
export function parse(input: unknown): object {
  return { input };
}

// Distinct return types are distinct overloads (open-Q1 resolved: return in hash).
export function read(): string;
export function read(flag: true): number;
export function read(flag?: boolean): string | number {
  return flag ? 1 : 'x';
}
