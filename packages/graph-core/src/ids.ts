/**
 * Identity (ADR-0002): IDs are deterministic functions of semantic
 * coordinates — `tag ++ base32( SHA-256( canonical(tuple) )[0..128 bits] )`
 * with tag ∈ {n, g, e}. Opaque hand-written IDs (fixtures) are also legal
 * model input; U4 binds parsers from Phase 2.
 */
import { MeridianError } from './errors.js';
import { sha256 } from './sha256.js';

declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type NodeId = Brand<string, 'NodeId'>;
export type GraphId = Brand<string, 'GraphId'>;
export type EdgeId = Brand<string, 'EdgeId'>;

/** Coordinate separator (ADR-0002); forbidden inside any segment or ID. */
export const COORD_SEPARATOR = '\u001f';

const B32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** RFC 4648 base32 (lowercase, unpadded) over the first 16 bytes → 26 chars. */
function base32_128(bytes: Uint8Array): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < 16; i++) {
    acc = (acc << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32_ALPHABET[(acc >> bits) & 31]!;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(acc << (5 - bits)) & 31]!;
  return out;
}

/**
 * Semantic coordinates of an element (ADR-0002): the producer's domain, a
 * stable source key, and an ordered path of stable local segments.
 */
export interface SemanticCoords {
  readonly domain: string;
  readonly source: string;
  readonly path: readonly string[];
}

function canonicalSegment(value: string, what: string, allowEmpty = false): string {
  const nfc = value.normalize('NFC');
  if (!allowEmpty && nfc.length === 0) {
    throw new MeridianError('empty-coordinate', `${what} must be a non-empty string`);
  }
  if (nfc.includes(COORD_SEPARATOR)) {
    throw new MeridianError(
      'separator-in-coordinate',
      `${what} must not contain U+001F (the coordinate separator)`,
    );
  }
  return nfc;
}

function deriveId(tag: 'n' | 'g' | 'e', segments: readonly string[]): string {
  const canonical = segments.join(COORD_SEPARATOR);
  const digest = sha256(new TextEncoder().encode(canonical));
  return tag + base32_128(digest);
}

function coordSegments(c: SemanticCoords): string[] {
  return [
    canonicalSegment(c.domain, 'domain'),
    canonicalSegment(c.source, 'source'),
    ...c.path.map((seg, i) => canonicalSegment(seg, `path[${i}]`)),
  ];
}

/** Deterministic NodeId from semantic coordinates (pure; I6). */
export function deriveNodeId(coords: SemanticCoords): NodeId {
  return deriveId('n', coordSegments(coords)) as NodeId;
}

/**
 * Deterministic GraphId for the detail graph of the node at `coords`
 * (the "detail-of" relation, ADR-0002). Root graphs use the source's own
 * coordinates with an empty path.
 */
export function deriveGraphId(coords: SemanticCoords): GraphId {
  return deriveId('g', coordSegments(coords)) as GraphId;
}

/**
 * Deterministic EdgeId. `occurrence` distinguishes several same-kind edges
 * between the same ordered pair (e.g. two call sites); empty for the common
 * single-edge case.
 */
export function deriveEdgeId(e: {
  readonly graph: GraphId;
  readonly kind: string;
  readonly src: NodeId;
  readonly dst: NodeId;
  readonly occurrence?: string;
}): EdgeId {
  return deriveId('e', [
    canonicalSegment(e.graph, 'graph'),
    canonicalSegment(e.kind, 'kind'),
    canonicalSegment(e.src, 'src'),
    canonicalSegment(e.dst, 'dst'),
    canonicalSegment(e.occurrence ?? '', 'occurrence', true),
  ]) as EdgeId;
}

function checkedId(id: string, what: string): string {
  if (id.length === 0) {
    throw new MeridianError('invalid-id', `${what} must be a non-empty string`);
  }
  if (id.includes(COORD_SEPARATOR)) {
    throw new MeridianError('invalid-id', `${what} must not contain U+001F`);
  }
  return id;
}

/** Brand an opaque (e.g. hand-written fixture) ID. Validates shape only. */
export function asNodeId(id: string): NodeId {
  return checkedId(id, 'NodeId') as NodeId;
}
export function asGraphId(id: string): GraphId {
  return checkedId(id, 'GraphId') as GraphId;
}
export function asEdgeId(id: string): EdgeId {
  return checkedId(id, 'EdgeId') as EdgeId;
}
