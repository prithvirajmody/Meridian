/**
 * `@meridian/adapter-argument` as a Meridian plugin (ROADMAP Phase 9D):
 * essays/debates → a deterministic essay → paragraph → sentence skeleton.
 * Deterministic, AI-free, isomorphic in `src` (no `node:*`, no DOM, no
 * network, no store): it sees only `plugin-api` (§20). One export, no
 * module-scope side effects (ADR-0009); `activate` returns the parser,
 * importing this module does nothing.
 *
 * The manifest declares the whole Phase 9 argument vocabulary — including the
 * `arg:thesis|claim|premise|objection|evidence` nodes and
 * `arg:supports|rebuts|assumes|cites` edges that only the 9D AI enrichment
 * pass produces — so an enriched graph validates against one registered
 * vocabulary. `apiVersion` stays caret `^0.2.0`; the 1.0 freeze is 9E.
 *
 * **Sniff is a deliberate under-bid.** Prose has no structural marker that
 * says "read me as an argument" — a `.md` essay is legitimately claimed by
 * the markdown adapter; the argument reading is a *user intent*, expressed
 * as an explicit `--adapter argument`. The parser therefore claims any
 * genuine text at 0.1 — strictly below the markdown adapter's 0.15
 * any-text floor and every real format score — so it satisfies the §7.4
 * claim-your-corpus law without ever winning an arbitration it has no
 * evidence for.
 */
import type { MeridianPlugin, PluginManifest, SourceDescriptor } from '@meridian/plugin-api';
import { buildDocument, DOMAIN } from './document.js';
import { ArgumentParseError } from './errors.js';
import { containsNul, parseEssay } from './parse.js';

const VERSION = '0.1.0';

export const manifest: PluginManifest = {
  name: '@meridian/adapter-argument',
  version: VERSION,
  apiVersion: '^0.2.0',
  capabilities: [{ kind: 'domain-parser', id: DOMAIN }],
  kinds: [
    'arg:essay',
    'arg:paragraph',
    'arg:sentence',
    'arg:thesis',
    'arg:claim',
    'arg:premise',
    'arg:objection',
    'arg:evidence',
    'arg:supports',
    'arg:rebuts',
    'arg:assumes',
    'arg:cites',
  ],
  attrSchemas: {
    'arg:index': { type: 'number', description: '0-based order of an element within its graph' },
  },
  levelChain: {
    domain: DOMAIN,
    levels: [{ name: 'essay' }, { name: 'paragraph' }, { name: 'sentence' }],
  },
};

export const argumentPlugin: MeridianPlugin = {
  manifest,
  activate: (ctx) => ({
    parsers: [
      {
        domain: DOMAIN,
        // Deliberate under-bid (module doc): claim text, never win arbitration.
        sniff: (src: SourceDescriptor) =>
          src.text === undefined || containsNul(src.text) ? 0 : 0.1,
        ingest: async (src, sink) => {
          if (src.text === undefined) {
            throw new ArgumentParseError(
              `parser needs text; ${src.bytes ? 'binary bytes' : 'no content'} provided`,
              { uri: src.uri },
            );
          }
          sink.progress({ stage: 'parse', done: 0 });
          const essay = parseEssay(src.text, src.uri);
          sink.progress({ stage: 'build', done: 1 });
          sink.emitDocument(buildDocument(ctx, src, essay, VERSION));
        },
      },
    ],
  }),
};
