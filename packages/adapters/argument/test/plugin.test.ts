/**
 * The plugin surface (ROADMAP Phase 9D): a single stateless domain-parser
 * whose sniff is a deliberate under-bid (claims genuine text at 0.1, never
 * outbidding a format with real evidence), ingests an essay into one
 * gate-clean document, rejects text-free and binary sources honestly, and
 * stays usable after a rejection (crash containment, §7.4). Driven exactly
 * as a host would drive it — no plugin-host import.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { idFacade, vocabularyOf } from '@meridian/conformance-kit';
import { decode } from '@meridian/graph-core';
import {
  PLUGIN_API_VERSION,
  type DomainParser,
  type GraphDocument,
  type IngestSink,
  type PluginContext,
  type Progress,
  type SourceDescriptor,
} from '@meridian/plugin-api';
import { describe, expect, it } from 'vitest';
import { argumentPlugin, manifest } from '../src/index.js';

const ctx: PluginContext = {
  apiVersion: PLUGIN_API_VERSION,
  ids: idFacade(),
  log: { info: () => undefined, warn: () => undefined },
};

function parser(): DomainParser {
  const parsers = argumentPlugin.activate(ctx).parsers ?? [];
  expect(parsers).toHaveLength(1);
  return parsers[0]!;
}

interface Run {
  readonly documents: GraphDocument[];
  readonly stages: string[];
}
async function ingest(src: SourceDescriptor): Promise<Run> {
  const documents: GraphDocument[] = [];
  const stages: string[] = [];
  const sink: IngestSink = {
    emitDocument: (d) => documents.push(d),
    emitDelta: () => undefined,
    progress: (p: Progress) => stages.push(p.stage),
  };
  await parser().ingest(src, sink);
  return { documents, stages };
}

const corpusDir = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../fixtures/corpora/argument',
);
const essayText = readFileSync(resolve(corpusDir, 'pedestrian-centers.md'), 'utf8');

describe('activation & manifest', () => {
  it('exposes exactly one parser for the argument domain', () => {
    expect(parser().domain).toBe('argument');
    expect(manifest.capabilities).toEqual([{ kind: 'domain-parser', id: 'argument' }]);
  });

  it('declares the whole Phase 9 argument vocabulary and the level chain', () => {
    expect(manifest.kinds).toContain('arg:sentence');
    expect(manifest.kinds).toContain('arg:claim');
    expect(manifest.kinds).toContain('arg:supports');
    expect(manifest.levelChain?.levels.map((l) => l.name)).toEqual(['essay', 'paragraph', 'sentence']);
  });
});

describe('sniff — the deliberate under-bid', () => {
  it('claims genuine text at exactly 0.1 (below the markdown 0.15 floor)', () => {
    expect(parser().sniff({ uri: 'a.md', text: essayText })).toBe(0.1);
    expect(parser().sniff({ uri: 'a.txt', text: 'plain prose' })).toBe(0.1);
  });

  it('scores 0 for missing text and for binary', () => {
    expect(parser().sniff({ uri: 'a.bin' })).toBe(0);
    expect(parser().sniff({ uri: 'a.bin', text: 'x\u0000y' })).toBe(0);
  });
});

describe('ingest', () => {
  it('the corpus essay becomes one gate-clean document: 7 paragraphs + heading, sentences under each', async () => {
    const run = await ingest({ uri: 'essay.md', text: essayText, mediaType: 'text/markdown' });
    expect(run.documents).toHaveLength(1);
    expect(run.stages).toEqual(['parse', 'build']);
    const doc = run.documents[0]!;
    const gated = decode(JSON.stringify(doc), { vocabulary: vocabularyOf(manifest) });
    expect(gated.ok, JSON.stringify(!gated.ok ? gated.errors : [])).toBe(true);
    const nodes = doc.graphs.flatMap((g) => g.nodes);
    expect(nodes.filter((n) => n.kind === 'arg:essay')).toHaveLength(1);
    expect(nodes.filter((n) => n.kind === 'arg:paragraph')).toHaveLength(8); // heading + 7 prose
    expect(nodes.filter((n) => n.kind === 'arg:sentence').length).toBeGreaterThan(20);
  });

  it('rejects a text-free source honestly and stays usable after (crash containment)', async () => {
    const p = parser();
    await expect(ingest({ uri: 'no-text.bin' })).rejects.toThrowError(/needs text/);
    const run = await ingest({ uri: 'after.txt', text: 'Still works. Fine.' });
    expect(run.documents).toHaveLength(1);
    expect(p.sniff({ uri: 'after.txt', text: 'Still works.' })).toBe(0.1);
  });

  it('rejects binary text with a located error', async () => {
    await expect(ingest({ uri: 'junk.txt', text: 'a\u0000b' })).rejects.toThrowError(/binary/);
  });
});
