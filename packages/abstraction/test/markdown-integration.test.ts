/**
 * Phase 3B exit criterion #2: the markdown corpus gets a working default
 * level chain with **zero adapter changes**. This drives the real
 * `@meridian/adapter-markdown` through the same buffered-sink path a host
 * uses, decodes its IR into a `GraphSpace`, builds the *default*
 * containment-depth chain (the adapter declares no `levelChain`), and builds
 * a covering cut at every level. The adapter is imported unmodified.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, type GraphDocument } from '@meridian/graph-core';
import { markdownPlugin } from '@meridian/adapter-markdown';
import {
  idFacade,
  loadCorpusDir,
  vocabularyOf,
  type CorpusEntry,
} from '@meridian/conformance-kit';
import { PLUGIN_API_VERSION } from '@meridian/plugin-api';
import { describe, expect, it } from 'vitest';
import { buildCut, verifyCoverage } from '../src/cut.js';
import { buildLevelChain } from '../src/level-chain.js';

const corpusDir = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../fixtures/corpora/markdown',
);

const context = {
  apiVersion: PLUGIN_API_VERSION,
  ids: idFacade(),
  log: { info: () => undefined, warn: () => undefined },
};

async function ingestToDocument(entry: CorpusEntry): Promise<GraphDocument | undefined> {
  const parser = markdownPlugin.activate(context).parsers![0]!;
  let doc: GraphDocument | undefined;
  await parser.ingest(entry.source, {
    emitDocument: (d) => {
      doc = d;
    },
    emitDelta: () => undefined,
    progress: () => undefined,
  });
  return doc;
}

const corpus = loadCorpusDir(corpusDir, {
  uriBase: 'fixtures/corpora/markdown/',
  mediaTypes: { md: 'text/markdown', markdown: 'text/markdown' },
}).filter((e) => (e.expect ?? 'ok') === 'ok');

describe('markdown corpus → default level chain + cuts (zero adapter changes)', () => {
  it('the markdown adapter declares no level chain (default must suffice)', () => {
    expect(markdownPlugin.manifest.levelChain).toBeUndefined();
  });

  for (const entry of corpus) {
    it(`"${entry.name}": builds a chain and a covering cut at every level`, async () => {
      const doc = await ingestToDocument(entry);
      expect(doc, `"${entry.name}" must emit a document`).toBeDefined();
      const gate = decode(doc!, { vocabulary: vocabularyOf(markdownPlugin.manifest) });
      expect(gate.ok ? [] : gate.errors).toEqual([]);
      if (!gate.ok) return;
      const space = gate.space;

      const chain = buildLevelChain(space); // no spec — default containment depth
      expect(chain.depth).toBeGreaterThanOrEqual(0);

      // A cut at every named level plus one past the deepest node must cover.
      for (let level = 0; level <= chain.depth; level++) {
        const cut = buildCut(space, chain, level);
        expect(cut.coverage.covers, `${entry.name} @ level ${level}`).toBe(true);
        expect(verifyCoverage(space, cut).ok, `${entry.name} @ level ${level}`).toBe(true);
      }
    });
  }

  it('a real book (basic.md) zooms: coarser levels have no more nodes than finer', async () => {
    const entry = corpus.find((e) => e.name === 'basic.md');
    expect(entry, 'basic.md must be in the corpus').toBeDefined();
    const doc = await ingestToDocument(entry!);
    const gate = decode(doc!, { vocabulary: vocabularyOf(markdownPlugin.manifest) });
    expect(gate.ok).toBe(true);
    if (!gate.ok) return;
    const space = gate.space;
    const chain = buildLevelChain(space);
    expect(chain.depth).toBeGreaterThan(1); // basic.md is genuinely nested

    // Zooming in never shrinks the visible set (finer ⊇ coarser in count).
    let prev = 0;
    for (let level = 0; level < chain.depth; level++) {
      const count = buildCut(space, chain, level).members.length;
      expect(count, `level ${level} count vs level ${level - 1}`).toBeGreaterThanOrEqual(prev);
      prev = count;
    }
  });
});
