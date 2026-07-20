/**
 * Deterministic bridge-v1 artifact construction and publication.
 *
 * This module is CLI-only: graph-core owns neutral document metadata, while
 * hashing, output-path policy, producer versions, and completion-marker order
 * belong to the composition root (ADR-0045/0046).
 */
import { createHash } from 'node:crypto';
import { lstat, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import {
  CURRENT_FORMAT_VERSION,
  stats,
  type DocumentSource,
  type GraphSpace,
} from '@meridian/graph-core';
import {
  bridgeGraphArtifactSchema,
  bridgeSourcePinSchema,
  type BridgeGraphArtifactV1,
} from './bridge-contract.js';

export const MERIDIAN_VERSION = '0.1.0';
export const GRAPH_STORE_VERSION = '0.1.0';
export const GRAPH_STORE_PACKAGE = '@meridian/graph-store';

const SAFE_FILE_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/u;

export class BridgeArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeArtifactError';
  }
}

export interface BridgeOutputPair {
  readonly artifactPath: string;
  readonly descriptorPath: string;
  readonly artifactReference: string;
}

export function parseBridgeSourcePin(repo: string, ref: string): { repo: string; ref: string } {
  const parsed = bridgeSourcePinSchema.safeParse({ repo, ref });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const at = first?.path.length ? `${first.path.join('.')}: ` : '';
    throw new BridgeArtifactError(`invalid bridge source pin: ${at}${first?.message ?? 'invalid value'}`);
  }
  return parsed.data;
}

export function resolveBridgeOutputPair(
  artifact: string,
  descriptor: string,
  forbidden: readonly string[] = [],
): BridgeOutputPair {
  const artifactPath = resolve(artifact);
  const descriptorPath = resolve(descriptor);
  if (dirname(artifactPath) !== dirname(descriptorPath)) {
    throw new BridgeArtifactError('artifact and descriptor must be in the same directory');
  }
  if (artifactPath === descriptorPath) {
    throw new BridgeArtifactError('artifact and descriptor paths must be different');
  }
  for (const path of forbidden) {
    const reserved = resolve(path);
    if (artifactPath === reserved || descriptorPath === reserved) {
      throw new BridgeArtifactError('artifact outputs must not overwrite an input');
    }
  }
  const artifactReference = basename(artifactPath);
  const descriptorName = basename(descriptorPath);
  if (!SAFE_FILE_NAME.test(artifactReference) || !SAFE_FILE_NAME.test(descriptorName)) {
    throw new BridgeArtifactError(
      'artifact and descriptor filenames must use only letters, digits, dot, underscore, or hyphen',
    );
  }
  return { artifactPath, descriptorPath, artifactReference };
}

export function makeDocumentSource(
  repo: string,
  ref: string,
  adapter: string,
  adapterPackage: string,
  adapterVersion: string,
): DocumentSource {
  const pin = parseBridgeSourcePin(repo, ref);
  return {
    ...pin,
    ingested_by: {
      meridian_version: MERIDIAN_VERSION,
      adapter,
      adapter_versions: { [adapterPackage]: adapterVersion },
    },
  };
}

export function sha256Utf8(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function utf8Size(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export function canonicalBridgeJson(value: unknown): string {
  return JSON.stringify(value);
}

export function buildGraphArtifact(
  space: GraphSpace,
  document: string,
  documentBytes: string,
  source: DocumentSource,
): BridgeGraphArtifactV1 {
  const counts = stats(space);
  const domains = [...new Set([...space.graphs.values()].map((graph) => graph.meta.domain))].sort();
  return bridgeGraphArtifactSchema.parse({
    schema_version: 1,
    kind: 'meridian-graph',
    target: { repo: source.repo, ref: source.ref },
    produced_by: source.ingested_by,
    document,
    document_sha256: sha256Utf8(documentBytes),
    document_size_bytes: utf8Size(documentBytes),
    graph_format_version: CURRENT_FORMAT_VERSION,
    node_count: counts.nodes,
    edge_count: counts.edges,
    domains,
  });
}

async function assertReplaceable(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new BridgeArtifactError(`refusing symlink output: ${path}`);
    if (!info.isFile()) throw new BridgeArtifactError(`output is not a regular file: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  await assertReplaceable(path);
  const temporary = resolve(dirname(path), `.${basename(path)}.tmp-${process.pid}`);
  await unlinkIfPresent(temporary);
  try {
    await writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlinkIfPresent(temporary);
  }
}

/** Write evidence first and its descriptor completion marker last. */
export async function writeBridgeOutputPair(
  pair: BridgeOutputPair,
  artifactBytes: string,
  descriptorBytes: string,
): Promise<void> {
  await assertReplaceable(pair.descriptorPath);
  await unlinkIfPresent(pair.descriptorPath);
  await writeAtomic(pair.artifactPath, artifactBytes);
  await writeAtomic(pair.descriptorPath, descriptorBytes);
}
