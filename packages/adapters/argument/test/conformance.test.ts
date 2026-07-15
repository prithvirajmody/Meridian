/**
 * The contract's executable law (ARCHITECTURE.md §7.4), applied to the
 * argument adapter (ROADMAP Phase 9D): the corpus — the reference essay,
 * a one-paragraph text, and an empty file — must ingest gate-clean,
 * deterministically, and AI-free; binary junk under `reject/` must be
 * contained (crash containment).
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeParserConformance, loadCorpusDir } from '@meridian/conformance-kit';
import { argumentPlugin } from '../src/index.js';

const corpusDir = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../fixtures/corpora/argument',
);

describeParserConformance({
  plugin: argumentPlugin,
  corpus: loadCorpusDir(corpusDir, {
    uriBase: 'fixtures/corpora/argument/',
    mediaTypes: { md: 'text/markdown', txt: 'text/plain' },
  }),
});
