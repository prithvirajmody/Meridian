/**
 * The contract's executable law (ARCHITECTURE.md §7.4), applied to the org
 * adapter (ADR-0047): the whole corpus — a teamed bundle with runs, bare
 * minimal / nested-team / full software-company definitions — must ingest
 * gate-clean, deterministically (I6: byte-identical re-ingest), and AI-free;
 * malformed JSON, an unknown schema_version, a bare run-events document (not
 * an adapter input), a structurally broken bundle, and binary/NUL junk under
 * `reject/` must be contained (crash containment).
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeParserConformance, loadCorpusDir } from '@meridian/conformance-kit';
import { orgPlugin } from '../src/index.js';

const corpusDir = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../fixtures/corpora/org',
);

describeParserConformance({
  plugin: orgPlugin,
  corpus: loadCorpusDir(corpusDir, {
    uriBase: 'fixtures/corpora/org/',
    mediaTypes: { json: 'application/json' },
  }),
});
