/**
 * Bridge-v1's TypeScript structural twin. The neutral JSON Schemas and fixture
 * bytes live under contracts/bridge-v1; these Zod gates deliberately accept
 * additive unknown fields while fixing every v1-required field and meaning.
 * Producer wiring remains outside this module and behind ADR-0045/0046.
 */
import { z } from 'zod';

export interface BridgeSourcePinV1 {
  readonly repo: string;
  readonly ref: string;
}

export interface BridgeGraphProducerV1 {
  readonly meridian_version: string;
  readonly adapter: string;
  readonly adapter_versions: Record<string, string>;
}

export interface BridgeGraphArtifactV1 {
  readonly schema_version: 1;
  readonly kind: 'meridian-graph';
  readonly target: BridgeSourcePinV1;
  readonly produced_by: BridgeGraphProducerV1;
  readonly document: string;
  readonly document_sha256: string;
  readonly document_size_bytes: number;
  readonly graph_format_version: number;
  readonly node_count: number;
  readonly edge_count: number;
  readonly domains: string[];
}

export interface BridgeDiffEndpointV1 extends BridgeSourcePinV1 {
  readonly document_sha256: string;
  readonly document_size_bytes: number;
  readonly graph_format_version: number;
}

export interface BridgeDiffProducerV1 {
  readonly meridian_version: string;
  readonly diff_engine: string;
  readonly diff_engine_version: string;
}

export interface BridgeKindCountsV1 {
  readonly added: number;
  readonly removed: number;
}

export interface BridgeDiffSummaryV1 {
  readonly nodes_added: number;
  readonly nodes_removed: number;
  readonly nodes_moved: number;
  readonly edges_added: number;
  readonly edges_removed: number;
  readonly by_kind: Record<string, BridgeKindCountsV1>;
}

export interface BridgeDiffArtifactV1 {
  readonly schema_version: 1;
  readonly kind: 'meridian-diff';
  readonly from: BridgeDiffEndpointV1;
  readonly to: BridgeDiffEndpointV1;
  readonly produced_by: BridgeDiffProducerV1;
  readonly summary: BridgeDiffSummaryV1;
  readonly delta: string;
  readonly delta_sha256: string;
  readonly delta_size_bytes: number;
  readonly delta_format_version: 1;
}

interface BridgeOpBaseV1 {
  readonly t: string;
  readonly graph: string;
}

interface GraphAddOpV1 extends BridgeOpBaseV1 {
  readonly t: 'graph:add';
  readonly meta: Record<string, unknown>;
}

interface GraphRemoveOpV1 extends BridgeOpBaseV1 {
  readonly t: 'graph:remove';
  readonly prev: Record<string, unknown>;
}

interface GraphMetaOpV1 extends BridgeOpBaseV1 {
  readonly t: 'graph:meta';
  readonly prev: Record<string, unknown>;
  readonly next: Record<string, unknown>;
}

interface NodeAddOpV1 extends BridgeOpBaseV1 {
  readonly t: 'node:add';
  readonly node: Record<string, unknown>;
}

interface NodeRemoveOpV1 extends BridgeOpBaseV1 {
  readonly t: 'node:remove';
  readonly id: string;
  readonly prev: Record<string, unknown>;
}

interface NodeAttrOpV1 extends BridgeOpBaseV1 {
  readonly t: 'node:attr';
  readonly id: string;
  readonly key: string;
  readonly prev?: unknown;
  readonly next?: unknown;
}

interface NodeDetailOpV1 extends BridgeOpBaseV1 {
  readonly t: 'node:detail';
  readonly id: string;
  readonly prev?: { readonly graph: string };
  readonly next?: { readonly graph: string };
}

interface EdgeAddOpV1 extends BridgeOpBaseV1 {
  readonly t: 'edge:add';
  readonly edge: Record<string, unknown>;
}

interface EdgeRemoveOpV1 extends BridgeOpBaseV1 {
  readonly t: 'edge:remove';
  readonly id: string;
  readonly prev: Record<string, unknown>;
}

export type BridgeOpV1 =
  | GraphAddOpV1
  | GraphRemoveOpV1
  | GraphMetaOpV1
  | NodeAddOpV1
  | NodeRemoveOpV1
  | NodeAttrOpV1
  | NodeDetailOpV1
  | EdgeAddOpV1
  | EdgeRemoveOpV1;

export interface BridgeStructuralDeltaV1 {
  readonly schema_version: 1;
  readonly kind: 'meridian-structural-delta';
  readonly from: BridgeSourcePinV1;
  readonly to: BridgeSourcePinV1;
  readonly origin: { readonly actor: 'meridian:diff' };
  readonly ops: BridgeOpV1[];
}

const fullSha = z.string().regex(/^[0-9a-f]{40}$/u);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const version = z.string().min(1).max(128);
const nonnegativeInteger = z.number().int().nonnegative();
const safePath = z
  .string()
  .min(1)
  .max(512)
  .regex(/^(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\\)[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u);
const jsonObject = z.record(z.string(), z.unknown());

export const bridgeSourcePinSchema = z.object({
  repo: z.string().url().min(1).max(2048),
  ref: fullSha,
}) satisfies z.ZodType<BridgeSourcePinV1>;

export const bridgeGraphProducerSchema = z
  .object({
    meridian_version: version,
    adapter: z.string().min(1).max(128),
    adapter_versions: z.record(z.string().min(1).max(256), version),
  })
  .refine((value) => Object.keys(value.adapter_versions).length > 0, {
    message: 'adapter_versions must not be empty',
  }) satisfies z.ZodType<BridgeGraphProducerV1>;

const uniqueDomains = z
  .array(z.string().min(1).max(128))
  .refine((values) => new Set(values).size === values.length, {
    message: 'domains must be unique',
  });

export const bridgeGraphArtifactSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal('meridian-graph'),
  target: bridgeSourcePinSchema,
  produced_by: bridgeGraphProducerSchema,
  document: safePath,
  document_sha256: sha256,
  document_size_bytes: nonnegativeInteger.max(1_073_741_824),
  graph_format_version: nonnegativeInteger.min(1),
  node_count: nonnegativeInteger,
  edge_count: nonnegativeInteger,
  domains: uniqueDomains,
}) satisfies z.ZodType<BridgeGraphArtifactV1>;

export const bridgeDiffEndpointSchema = bridgeSourcePinSchema.extend({
  document_sha256: sha256,
  document_size_bytes: nonnegativeInteger.max(1_073_741_824),
  graph_format_version: nonnegativeInteger.min(1),
}) satisfies z.ZodType<BridgeDiffEndpointV1>;

export const bridgeDiffProducerSchema = z.object({
  meridian_version: version,
  diff_engine: z.string().min(1).max(256),
  diff_engine_version: version,
}) satisfies z.ZodType<BridgeDiffProducerV1>;

const kindCounts = z.object({
  added: nonnegativeInteger,
  removed: nonnegativeInteger,
}) satisfies z.ZodType<BridgeKindCountsV1>;

export const bridgeDiffSummarySchema = z.object({
  nodes_added: nonnegativeInteger,
  nodes_removed: nonnegativeInteger,
  nodes_moved: nonnegativeInteger,
  edges_added: nonnegativeInteger,
  edges_removed: nonnegativeInteger,
  by_kind: z.record(z.string().min(1).max(256), kindCounts),
}) satisfies z.ZodType<BridgeDiffSummaryV1>;

export const bridgeDiffArtifactSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal('meridian-diff'),
  from: bridgeDiffEndpointSchema,
  to: bridgeDiffEndpointSchema,
  produced_by: bridgeDiffProducerSchema,
  summary: bridgeDiffSummarySchema,
  delta: safePath,
  delta_sha256: sha256,
  delta_size_bytes: nonnegativeInteger.max(1_073_741_824),
  delta_format_version: z.literal(1),
}) satisfies z.ZodType<BridgeDiffArtifactV1>;

const opBase = {
  graph: z.string().min(1),
};
const graphRef = z.object({ graph: z.string().min(1) });

const nodeAttrOp = z
  .object({
    ...opBase,
    t: z.literal('node:attr'),
    id: z.string().min(1),
    key: z.string().min(1),
    prev: z.unknown().optional(),
    next: z.unknown().optional(),
  })
  .refine((value) => 'prev' in value || 'next' in value, {
    message: 'node:attr requires prev or next',
  });

const nodeDetailOp = z
  .object({
    ...opBase,
    t: z.literal('node:detail'),
    id: z.string().min(1),
    prev: graphRef.optional(),
    next: graphRef.optional(),
  })
  .refine((value) => value.prev !== undefined || value.next !== undefined, {
    message: 'node:detail requires prev or next',
  });

export const bridgeOpSchema = z.union([
  z.object({ ...opBase, t: z.literal('graph:add'), meta: jsonObject }),
  z.object({ ...opBase, t: z.literal('graph:remove'), prev: jsonObject }),
  z.object({ ...opBase, t: z.literal('graph:meta'), prev: jsonObject, next: jsonObject }),
  z.object({ ...opBase, t: z.literal('node:add'), node: jsonObject }),
  z.object({ ...opBase, t: z.literal('node:remove'), id: z.string().min(1), prev: jsonObject }),
  nodeAttrOp,
  nodeDetailOp,
  z.object({ ...opBase, t: z.literal('edge:add'), edge: jsonObject }),
  z.object({ ...opBase, t: z.literal('edge:remove'), id: z.string().min(1), prev: jsonObject }),
]) satisfies z.ZodType<BridgeOpV1>;

export const bridgeStructuralDeltaSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal('meridian-structural-delta'),
  from: bridgeSourcePinSchema,
  to: bridgeSourcePinSchema,
  origin: z.object({ actor: z.literal('meridian:diff') }),
  ops: z.array(bridgeOpSchema),
}) satisfies z.ZodType<BridgeStructuralDeltaV1>;

export const BRIDGE_SCHEMAS = {
  'graph-artifact.schema.json': bridgeGraphArtifactSchema,
  'diff-artifact.schema.json': bridgeDiffArtifactSchema,
  'structural-delta.schema.json': bridgeStructuralDeltaSchema,
} as const;
