/**
 * The contract's executable law, applied to the first real adapter
 * (roadmap Phase 2 §11): the whole corpus — CommonMark edge cases,
 * pathological nesting, links, empties — must ingest gate-clean,
 * deterministically, AI-free; binary junk must be contained.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeParserConformance, loadCorpusDir } from '@meridian/conformance-kit';
import { markdownPlugin } from '../src/index.js';

const corpusDir = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../fixtures/corpora/markdown',
);

describeParserConformance({
  plugin: markdownPlugin,
  corpus: loadCorpusDir(corpusDir, {
    uriBase: 'fixtures/corpora/markdown/',
    mediaTypes: { md: 'text/markdown', markdown: 'text/markdown' },
  }),
});
