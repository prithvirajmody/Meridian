/**
 * GraphDocument codec (ADR-0004): parse-don't-validate at one gate.
 * decode = version check → migrations → structural zod parse (unknown keys
 * ignored and dropped) → NFC-normalizing transform → semantic validation.
 * encode = deterministic canonical form (sorted graphs/nodes/edges/roots/
 * attr keys); `encodeCanonical` (minified, hashable) and `encodePretty`
 * (fixtures/goldens) derive from the same form.
 */
import { z } from 'zod';
import type { AttrBag, AttrValue } from './attrs.js';
import type { EdgeId, GraphId, NodeId } from './ids.js';
import type {
  GraphSpace,
  SemanticEdge,
  SemanticGraph,
  SemanticNode,
  SourceRef,
} from './model.js';
import { canonAttrValue, canonNumber, canonProvenance, nfc } from './normalize.js';
import { validate, type Issue, type ValidateOptions } from './validate.js';
import { PKG_VERSION } from './version.js';

export const CURRENT_FORMAT_VERSION = 1;

/**
 * Single-step pure migration (ADR-0004): `from → from+1`, chained upward.
 * The registry is empty at v1; the hook signature is fixed now so the first
 * format bump is additive.
 */
export interface Migration {
  readonly from: number;
  readonly to: number;
  up(doc: unknown): unknown;
}

const MIGRATIONS: readonly Migration[] = [];

// ---------------------------------------------------------------- schemas

const provenanceSchema = z.object({
  origin: z.enum(['source', 'derived', 'ai']),
  uri: z.string().optional(),
  span: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
  providerId: z.string().optional(),
  model: z.string().optional(),
  promptVersion: z.string().optional(),
  inputHash: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const attrScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const attrValueSchema = z.union([
  attrScalarSchema,
  z.array(z.union([z.string(), z.number(), z.boolean()])),
]);
const attrBagSchema = z.record(z.string(), attrValueSchema);

const nodeSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  label: z.string(),
  detail: z.object({ graph: z.string().min(1) }).optional(),
  attrs: attrBagSchema.optional(),
  provenance: provenanceSchema,
});

const edgeSchema = z.object({
  id: z.string().min(1),
  src: z.string().min(1),
  dst: z.string().min(1),
  kind: z.string().min(1),
  weight: z.number().optional(),
  attrs: attrBagSchema.optional(),
  provenance: provenanceSchema,
});

const graphSchema = z.object({
  id: z.string().min(1),
  meta: z.object({
    label: z.string(),
    domain: z.string().min(1),
    provenance: provenanceSchema,
  }),
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
});

const documentSchema = z.object({
  formatVersion: z.literal(CURRENT_FORMAT_VERSION),
  producer: z.object({ name: z.string().min(1), version: z.string().min(1) }),
  roots: z.array(z.string().min(1)),
  graphs: z.array(graphSchema),
});

/** The wire form (ADR-0004). */
export type GraphDocument = z.infer<typeof documentSchema>;
export type DocumentProducer = GraphDocument['producer'];
type WireAttrBag = z.infer<typeof attrBagSchema>;

// ----------------------------------------------------------------- decode

export type DecodeResult =
  | { readonly ok: true; readonly space: GraphSpace; readonly warnings: Issue[] }
  | { readonly ok: false; readonly errors: Issue[]; readonly warnings: Issue[] };

function fail(errors: Issue[], warnings: Issue[] = []): DecodeResult {
  return { ok: false, errors, warnings };
}

function issue(code: Issue['code'], message: string, path?: string): Issue {
  return { code, severity: 'error', message, ...(path !== undefined ? { path } : {}) };
}

function nfcAttrs(attrs: WireAttrBag | undefined): AttrBag {
  const out: Record<string, AttrValue> = {};
  if (attrs) {
    // Heterogeneous arrays fit the wire schema but not AttrValue; the
    // semantic pass rejects them (invalid-attr-value), so the cast is safe.
    for (const [k, v] of Object.entries(attrs)) out[nfc(k)] = canonAttrValue(v as AttrValue);
  }
  return out;
}

function nfcProvenance(p: z.infer<typeof provenanceSchema>): SourceRef {
  return canonProvenance(p as SourceRef);
}

/** Options for `decode`. `vocabulary` turns the semantic pass into an IR gate (U8). */
export type DecodeOptions = ValidateOptions;

/**
 * Decode a `GraphDocument` (or its JSON text) into a valid `GraphSpace`.
 * There is no partially-valid result: any structural or semantic error fails
 * the decode, with all errors located, aggregated, and typed.
 */
export function decode(input: string | unknown, opts: DecodeOptions = {}): DecodeResult {
  let raw: unknown;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch (e) {
      return fail([issue('malformed-json', `not valid JSON: ${(e as Error).message}`)]);
    }
  } else {
    raw = input;
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail([issue('structural', 'document must be a JSON object', '(root)')]);
  }

  const fv = (raw as Record<string, unknown>).formatVersion;
  if (fv === undefined) {
    return fail([
      issue(
        'missing-format-version',
        'document has no formatVersion — there is no unversioned external surface (ARCHITECTURE.md §3.3)',
        'formatVersion',
      ),
    ]);
  }
  if (typeof fv !== 'number' || !Number.isInteger(fv) || fv < 1) {
    return fail([
      issue(
        'invalid-format-version',
        `formatVersion must be a positive integer, got ${JSON.stringify(fv)}`,
        'formatVersion',
      ),
    ]);
  }
  if (fv > CURRENT_FORMAT_VERSION) {
    return fail([
      issue(
        'unsupported-version',
        `document formatVersion ${fv} is newer than this build (supports ${CURRENT_FORMAT_VERSION}) — refusing rather than guessing (ADR-0004)`,
        'formatVersion',
      ),
    ]);
  }
  let current: unknown = raw;
  let at = fv;
  while (at < CURRENT_FORMAT_VERSION) {
    const step = MIGRATIONS.find((m) => m.from === at);
    if (!step) {
      return fail([
        issue(
          'unsupported-version',
          `no migration path from formatVersion ${at} to ${CURRENT_FORMAT_VERSION}`,
          'formatVersion',
        ),
      ]);
    }
    current = step.up(current);
    at = step.to;
  }

  const parsed = documentSchema.safeParse(current);
  if (!parsed.success) {
    return fail(
      parsed.error.issues.map((i) =>
        issue('structural', i.message, i.path.length ? i.path.join('.') : '(root)'),
      ),
    );
  }
  const doc = parsed.data;

  // Transform with NFC normalization. Duplicates inside one collection must
  // be caught here — a Map would silently collapse them (first wins).
  const dupErrors: Issue[] = [];
  const graphs = new Map<GraphId, SemanticGraph>();
  for (const g of doc.graphs) {
    const graphId = nfc(g.id) as GraphId;
    if (graphs.has(graphId)) {
      dupErrors.push({
        code: 'duplicate-id',
        severity: 'error',
        message: `graph "${graphId}" appears more than once in the document`,
        graphId: String(graphId),
      });
      continue;
    }
    const nodes = new Map<NodeId, SemanticNode>();
    for (const n of g.nodes) {
      const nodeId = nfc(n.id) as NodeId;
      if (nodes.has(nodeId)) {
        dupErrors.push({
          code: 'duplicate-id',
          severity: 'error',
          message: `node "${nodeId}" appears more than once in graph "${graphId}"`,
          graphId: String(graphId),
          elementId: String(nodeId),
        });
        continue;
      }
      nodes.set(nodeId, {
        id: nodeId,
        kind: nfc(n.kind),
        label: nfc(n.label),
        ...(n.detail ? { detail: { graph: nfc(n.detail.graph) as GraphId } } : {}),
        attrs: nfcAttrs(n.attrs),
        provenance: nfcProvenance(n.provenance),
      });
    }
    const edges = new Map<EdgeId, SemanticEdge>();
    for (const e of g.edges) {
      const edgeId = nfc(e.id) as EdgeId;
      if (edges.has(edgeId)) {
        dupErrors.push({
          code: 'duplicate-id',
          severity: 'error',
          message: `edge "${edgeId}" appears more than once in graph "${graphId}"`,
          graphId: String(graphId),
          elementId: String(edgeId),
        });
        continue;
      }
      edges.set(edgeId, {
        id: edgeId,
        src: nfc(e.src) as NodeId,
        dst: nfc(e.dst) as NodeId,
        kind: nfc(e.kind),
        ...(e.weight !== undefined ? { weight: canonNumber(e.weight) } : {}),
        attrs: nfcAttrs(e.attrs),
        provenance: nfcProvenance(e.provenance),
      });
    }
    graphs.set(graphId, {
      id: graphId,
      meta: {
        label: nfc(g.meta.label),
        domain: nfc(g.meta.domain),
        provenance: nfcProvenance(g.meta.provenance),
      },
      nodes,
      edges,
    });
  }

  const space: GraphSpace = {
    graphs,
    roots: doc.roots.map((r) => nfc(r) as GraphId),
  };

  const result = validate(space, opts);
  const errors = [...dupErrors, ...result.errors];
  if (errors.length > 0) return fail(errors, result.warnings);
  return { ok: true, space, warnings: result.warnings };
}

// ----------------------------------------------------------------- encode

const byId = <T extends { id: string }>(a: T, b: T): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

function sortedAttrs(attrs: AttrBag): WireAttrBag | undefined {
  const keys = Object.keys(attrs);
  if (keys.length === 0) return undefined;
  keys.sort();
  const out: WireAttrBag = {};
  for (const k of keys) {
    const canon = canonAttrValue(attrs[k]!);
    out[nfc(k)] = Array.isArray(canon)
      ? ([...canon] as (string | number | boolean)[])
      : (canon as string | number | boolean | null);
  }
  return out;
}

function encodeProvenance(p: SourceRef): GraphDocument['graphs'][number]['meta']['provenance'] {
  const c = canonProvenance(p);
  return {
    origin: c.origin,
    ...(c.uri !== undefined ? { uri: c.uri } : {}),
    ...(c.span !== undefined ? { span: [c.span[0], c.span[1]] as [number, number] } : {}),
    ...(c.providerId !== undefined ? { providerId: c.providerId } : {}),
    ...(c.model !== undefined ? { model: c.model } : {}),
    ...(c.promptVersion !== undefined ? { promptVersion: c.promptVersion } : {}),
    ...(c.inputHash !== undefined ? { inputHash: c.inputHash } : {}),
    ...(c.confidence !== undefined ? { confidence: c.confidence } : {}),
  };
}

export interface EncodeOptions {
  readonly producer?: DocumentProducer;
}

/** Deterministic wire form: same space ⇒ identical document (I6). */
export function encode(space: GraphSpace, opts: EncodeOptions = {}): GraphDocument {
  const producer = opts.producer ?? { name: '@meridian/graph-core', version: PKG_VERSION };
  const graphs = [...space.graphs.values()].sort(byId).map((g) => ({
    id: nfc(g.id),
    meta: {
      label: nfc(g.meta.label),
      domain: nfc(g.meta.domain),
      provenance: encodeProvenance(g.meta.provenance),
    },
    nodes: [...g.nodes.values()].sort(byId).map((n) => {
      const attrs = sortedAttrs(n.attrs);
      return {
        id: nfc(n.id),
        kind: nfc(n.kind),
        label: nfc(n.label),
        ...(n.detail ? { detail: { graph: nfc(n.detail.graph) } } : {}),
        ...(attrs ? { attrs } : {}),
        provenance: encodeProvenance(n.provenance),
      };
    }),
    edges: [...g.edges.values()].sort(byId).map((e) => {
      const attrs = sortedAttrs(e.attrs);
      return {
        id: nfc(e.id),
        src: nfc(e.src),
        dst: nfc(e.dst),
        kind: nfc(e.kind),
        ...(e.weight !== undefined ? { weight: canonNumber(e.weight) } : {}),
        ...(attrs ? { attrs } : {}),
        provenance: encodeProvenance(e.provenance),
      };
    }),
  }));
  return {
    formatVersion: CURRENT_FORMAT_VERSION,
    producer: { name: nfc(producer.name), version: nfc(producer.version) },
    roots: space.roots.map((r) => nfc(r)).sort(),
    graphs,
  };
}

/** Minified deterministic rendering — the form that gets hashed (ADR-0004). */
export function encodeCanonical(space: GraphSpace, opts: EncodeOptions = {}): string {
  return JSON.stringify(encode(space, opts));
}

/** Pretty deterministic rendering — the form fixtures and goldens store. */
export function encodePretty(space: GraphSpace, opts: EncodeOptions = {}): string {
  return JSON.stringify(encode(space, opts), null, 2) + '\n';
}
