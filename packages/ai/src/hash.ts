import { sha256Hex } from './sha256.js';

/**
 * Deterministic canonical JSON: object keys sorted recursively so that two
 * logically-equal inputs hash identically regardless of key insertion order.
 * `undefined` object properties are dropped (JSON.stringify semantics);
 * functions and symbols are not expected in gateway inputs.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = sortValue(record[key]);
    }
    return out;
  }
  return value;
}

const encoder = new TextEncoder();

export function hashString(input: string): string {
  return sha256Hex(encoder.encode(input));
}

/** Canonical input hash — stable across key order and across runs (ADR-0030). */
export function canonicalInputHash(value: unknown): string {
  return hashString(canonicalJson(value));
}
