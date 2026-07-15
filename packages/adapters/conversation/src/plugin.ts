/**
 * `@meridian/adapter-conversation` as a Meridian plugin (ROADMAP Phase 9B): LLM
 * chat exports (Claude / ChatGPT JSON) → a deterministic session → exchange →
 * message skeleton. Deterministic, AI-free, isomorphic in `src` (no `node:*`,
 * no DOM, no network, no store): it sees only `plugin-api` (§20) and JSON is
 * native. One export, no module-scope side effects (ADR-0009); `activate`
 * returns the parser, importing this module does nothing.
 *
 * The manifest declares the whole Phase 9 conversation vocabulary — including
 * the `conv:topic`/`conv:claim` nodes and `conv:about`/`conv:refers-back` edges
 * that only the 9C AI enrichment pass produces — so an enriched graph validates
 * against one registered vocabulary. `apiVersion` targets caret `^1.0.0` (the
 * 9E freeze, ADR-0033).
 */
import type { MeridianPlugin, PluginManifest, SourceDescriptor } from '@meridian/plugin-api';
import { buildDocument, DOMAIN } from './document.js';
import { ConversationParseError } from './errors.js';
import { containsNul } from './format/types.js';
import { parseExport } from './parse.js';

const VERSION = '0.1.0';

export const manifest: PluginManifest = {
  name: '@meridian/adapter-conversation',
  version: VERSION,
  apiVersion: '^1.0.0',
  capabilities: [{ kind: 'domain-parser', id: DOMAIN }],
  kinds: [
    'conv:session',
    'conv:topic',
    'conv:exchange',
    'conv:message',
    'conv:claim',
    'conv:replies-to',
    'conv:refers-back',
    'conv:about',
  ],
  attrSchemas: {
    'conv:index': { type: 'number', description: '0-based order of an element within its graph' },
    'conv:role': {
      type: 'string',
      description: 'normalized message role: user | assistant | system | tool | <verbatim source token>',
    },
    'conv:source-id': {
      type: 'string',
      description:
        'stable source identifier as the export recorded it (conversation uuid / message uuid / mapping-node id)',
    },
    'conv:timestamp': {
      type: 'string',
      description: 'source timestamp as written — ISO 8601 string or epoch-seconds decimal',
    },
  },
  levelChain: {
    domain: DOMAIN,
    levels: [{ name: 'session' }, { name: 'exchange' }, { name: 'message' }],
  },
};

/**
 * Bounded, conservative source sniff (pure): look only at the head of the text
 * for a structural key unique to a chat export. Arbitrary JSON scores 0 — the
 * adapter does not claim every `.json` file — so it never outranks a real
 * domain parser on unrelated data, while an explicit `--adapter conversation`
 * still ingests anything `parseExport` accepts.
 */
const SNIFF_WINDOW = 1 << 16;
function sniff(src: SourceDescriptor): number {
  if (src.text === undefined || containsNul(src.text)) return 0;
  const head = src.text.slice(0, SNIFF_WINDOW);
  const claude = head.includes('"chat_messages"') || (head.includes('"sender"') && head.includes('"uuid"'));
  const chatgpt = head.includes('"mapping"') && (head.includes('"current_node"') || head.includes('"author"'));
  return claude || chatgpt ? 0.95 : 0;
}

export const conversationPlugin: MeridianPlugin = {
  manifest,
  activate: (ctx) => ({
    parsers: [
      {
        domain: DOMAIN,
        sniff,
        ingest: async (src, sink) => {
          if (src.text === undefined) {
            throw new ConversationParseError(
              `parser needs text; ${src.bytes ? 'binary bytes' : 'no content'} provided`,
              { uri: src.uri },
            );
          }
          sink.progress({ stage: 'parse', done: 0 });
          const conversations = parseExport(src.text, src.uri);
          sink.progress({ stage: 'build', done: 1 });
          sink.emitDocument(buildDocument(ctx, src, conversations, VERSION));
        },
      },
    ],
  }),
};
