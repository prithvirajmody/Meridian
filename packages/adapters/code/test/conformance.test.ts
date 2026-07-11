/**
 * The domain-parser contract's executable law, applied to the code adapter
 * (7C TypeScript, 7D Python; ROADMAP §12): every `.ts`/`.py` corpus file —
 * classes, functions, bindings, overloads, duplicates, namespaces, default
 * exports, decorators/@overload, packages, a syntax-error file — must ingest
 * gate-clean, deterministically, AI-free, with identity stable under re-ingest;
 * the binary junk under `reject/` must be contained. Both languages are green
 * on the kit (the §7D exit criterion). The kit drives the plugin as a host does.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeParserConformance, loadCorpusDir } from '@meridian/conformance-kit';
import { afterAll } from 'vitest';
import { createCodePlugin } from '../src/index.js';
import { inProcessMapper } from './support.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const mapper = inProcessMapper();
afterAll(() => mapper.dispose());

for (const lang of ['code-ts', 'code-py'] as const) {
  describeParserConformance({
    plugin: createCodePlugin({ mapper }),
    corpus: loadCorpusDir(resolve(here, `../../../../fixtures/corpora/${lang}`), {
      uriBase: `fixtures/corpora/${lang}/`,
    }),
  });
}
