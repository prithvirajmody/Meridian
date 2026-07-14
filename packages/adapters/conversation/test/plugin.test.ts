/**
 * The plugin surface (ROADMAP Phase 9B): a single stateless domain-parser that
 * sniffs conservatively (never claims arbitrary JSON), ingests an export into
 * one gate-clean document through the buffered sink, rejects a text-free
 * source honestly, and stays usable after a rejection (crash containment,
 * §7.4). Driven exactly as a host would drive it — no plugin-host import.
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
import { conversationPlugin, manifest } from '../src/index.js';

const ctx: PluginContext = {
  apiVersion: PLUGIN_API_VERSION,
  ids: idFacade(),
  log: { info: () => undefined, warn: () => undefined },
};

function parser(): DomainParser {
  const parsers = conversationPlugin.activate(ctx).parsers ?? [];
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
  '../../../../fixtures/corpora/conversation',
);
const fixture = (name: string): string => readFileSync(resolve(corpusDir, name), 'utf8');

describe('activation', () => {
  it('exposes exactly one parser for the conversation domain', () => {
    expect(parser().domain).toBe(manifest.capabilities[0]!.id);
    expect(parser().domain).toBe('conversation');
  });

  it('activate is repeatable — importing/activating has no hidden state', () => {
    const a = conversationPlugin.activate(ctx).parsers ?? [];
    const b = conversationPlugin.activate(ctx).parsers ?? [];
    expect(a.map((p) => p.domain)).toEqual(b.map((p) => p.domain));
  });
});

describe('sniff — conservative, bounded, deterministic', () => {
  const score = (over: Partial<SourceDescriptor>): number => parser().sniff({ uri: 'x', ...over });

  it('claims a Claude or ChatGPT export by a structural signal', () => {
    expect(score({ text: fixture('claude-basic.json') })).toBeGreaterThan(0);
    expect(score({ text: fixture('chatgpt-basic.json') })).toBeGreaterThan(0);
    expect(score({ text: '{"chat_messages":[]}' })).toBe(0.95);
    expect(score({ text: '{"mapping":{},"current_node":"x"}' })).toBe(0.95);
  });

  it('does NOT claim arbitrary JSON — it is not a generic .json parser', () => {
    expect(score({ text: '{"hello":"world"}' })).toBe(0);
    expect(score({ text: '[{"a":1},{"b":2}]' })).toBe(0);
    expect(score({ text: 'plain text' })).toBe(0);
  });

  it('refuses text-free and binary sources', () => {
    expect(score({})).toBe(0);
    expect(score({ bytes: new Uint8Array([1, 2, 3]) })).toBe(0);
    expect(score({ text: 'a' + String.fromCharCode(0) + 'b' })).toBe(0);
  });

  it('is pure: repeated calls agree', () => {
    const src = { uri: 'x', text: fixture('chatgpt-branched.json') };
    expect(parser().sniff(src)).toBe(parser().sniff(src));
  });
});

describe('ingest — one gate-clean document through the sink', () => {
  it('emits exactly one document and reports progress stages', async () => {
    const run = await ingest({ uri: 'c.json', text: fixture('claude-basic.json') });
    expect(run.documents).toHaveLength(1);
    expect(run.stages).toContain('parse');
    expect(run.stages).toContain('build');
    const res = decode(run.documents[0]!, { vocabulary: vocabularyOf(manifest) });
    expect(res.ok ? [] : res.errors).toEqual([]);
  });

  it('rejects a text-free (binary) source with a located error', async () => {
    await expect(
      ingest({ uri: 'b.bin', bytes: new Uint8Array([0, 1, 2]) }),
    ).rejects.toThrow(/needs text/);
  });

  it('rejects a source with neither text nor bytes', async () => {
    await expect(ingest({ uri: 'empty' })).rejects.toThrow();
  });

  it('stays usable after a rejection (crash containment)', async () => {
    await expect(ingest({ uri: 'bad', text: '{ not json' })).rejects.toThrow();
    const run = await ingest({ uri: 'ok.json', text: fixture('chatgpt-basic.json') });
    expect(run.documents).toHaveLength(1);
  });
});
