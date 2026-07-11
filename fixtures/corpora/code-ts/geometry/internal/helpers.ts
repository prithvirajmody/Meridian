export const clamp = (value: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, value));

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
