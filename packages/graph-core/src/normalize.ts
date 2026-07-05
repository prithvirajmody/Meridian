/**
 * String and number canonicalization (ADR-0004 §normalization): NFC for all
 * strings, -0 collapsed to 0 so round-trips through JSON are exact.
 */
import type { AttrBag, AttrValue } from './attrs.js';
import type { SourceRef } from './model.js';

export function nfc(s: string): string {
  return s.normalize('NFC');
}

export function canonNumber(n: number): number {
  return n === 0 ? 0 : n;
}

export function canonAttrValue(v: AttrValue): AttrValue {
  if (typeof v === 'string') return nfc(v);
  if (typeof v === 'number') return canonNumber(v);
  if (Array.isArray(v)) {
    return v.map((x) =>
      typeof x === 'string' ? nfc(x) : typeof x === 'number' ? canonNumber(x) : x,
    ) as AttrValue;
  }
  return v;
}

export function canonAttrs(attrs: AttrBag): AttrBag {
  const out: Record<string, AttrValue> = {};
  for (const [k, v] of Object.entries(attrs)) out[nfc(k)] = canonAttrValue(v);
  return out;
}

export function canonProvenance(p: SourceRef): SourceRef {
  const out: {
    origin: SourceRef['origin'];
    uri?: string;
    span?: readonly [number, number];
    model?: string;
    confidence?: number;
  } = { origin: p.origin };
  if (p.uri !== undefined) out.uri = nfc(p.uri);
  if (p.span !== undefined) out.span = [p.span[0], p.span[1]];
  if (p.model !== undefined) out.model = nfc(p.model);
  if (p.confidence !== undefined) out.confidence = canonNumber(p.confidence);
  return out;
}
