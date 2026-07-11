/**
 * The domain-parser contract's executable law, applied to the code adapter
 * (7C, ROADMAP §12): every `.ts` corpus file — classes, functions, bindings,
 * overloads, duplicates, namespaces, default exports, a syntax-error file, a
 * nested package — must ingest gate-clean, deterministically, AI-free, with
 * identity stable under re-ingest; the binary junk under `reject/` must be
 * contained. The kit drives the plugin exactly as a host does.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeParserConformance, loadCorpusDir } from '@meridian/conformance-kit';
import { afterAll } from 'vitest';
import { createCodePlugin } from '../src/index.js';
import { inProcessMapper } from './support.js';

const corpusDir = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../fixtures/corpora/code-ts',
);

const mapper = inProcessMapper();
afterAll(() => mapper.dispose());

describeParserConformance({
  plugin: createCodePlugin({ mapper }),
  corpus: loadCorpusDir(corpusDir, { uriBase: 'fixtures/corpora/code-ts/' }),
});
