/**
 * The contract's executable law (ARCHITECTURE.md §7.4), applied to the
 * conversation adapter (ROADMAP Phase 9B): the whole corpus — realistic Claude
 * and ChatGPT exports, one-message, unicode/code, hand-edited, branched,
 * missing-parent, and empty conversations — must ingest gate-clean,
 * deterministically, and AI-free; malformed/truncated JSON, unrecognized JSON,
 * and binary/NUL junk under `reject/` must be contained (crash containment).
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeParserConformance, loadCorpusDir } from '@meridian/conformance-kit';
import { conversationPlugin } from '../src/index.js';

const corpusDir = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../fixtures/corpora/conversation',
);

describeParserConformance({
  plugin: conversationPlugin,
  corpus: loadCorpusDir(corpusDir, {
    uriBase: 'fixtures/corpora/conversation/',
    mediaTypes: { json: 'application/json' },
  }),
});
