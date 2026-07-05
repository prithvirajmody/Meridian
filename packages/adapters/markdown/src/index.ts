/**
 * @meridian/adapter-markdown — the first domain adapter (roadmap Phase 2):
 * CommonMark documents → nested semantic graphs. Deterministic, AI-free,
 * isomorphic; sees only plugin-api (§20). One export, no module-scope side
 * effects (ADR-0009).
 */
import type { MeridianPlugin, PluginManifest, SourceDescriptor } from '@meridian/plugin-api';
import { buildDocument, DOMAIN } from './document.js';
import { buildOutline } from './outline.js';

const VERSION = '0.1.0';

export const manifest: PluginManifest = {
  name: '@meridian/adapter-markdown',
  version: VERSION,
  apiVersion: '^0.1.0',
  capabilities: [{ kind: 'domain-parser', id: DOMAIN }],
  kinds: [
    'doc:section',
    'doc:paragraph',
    'doc:code',
    'doc:list',
    'doc:quote',
    'doc:html',
    'doc:break',
    'doc:links-to',
  ],
  attrSchemas: {
    'doc:index': { type: 'number', description: '0-based reading order within its graph' },
    'doc:level': { type: 'number', description: 'heading depth as written (1–6)' },
    'doc:lang': { type: 'string', description: 'fenced code block language tag' },
    'doc:items': { type: 'number', description: 'top-level item count of a list' },
    'doc:ordered': { type: 'boolean', description: 'whether a list is ordered' },
  },
};

const EXTENSION = /\.(md|markdown|mdown)$/i;
const HEADING = /^(#{1,6}\s|.+\n(=+|-+)\s*$)/m;

function looksBinary(text: string): boolean {
  return text.includes('\u0000') || text.includes('\uFFFD');
}

function sniff(src: SourceDescriptor): number {
  if (src.text === undefined || looksBinary(src.text)) return 0;
  if (src.mediaType === 'text/markdown') return 0.9;
  if (EXTENSION.test(src.uri)) return 0.85;
  if (HEADING.test(src.text)) return 0.4;
  // Any text is renderable CommonMark; a weak floor keeps plain prose usable
  // while letting any actual domain adapter outrank it.
  return 0.15;
}

export const markdownPlugin: MeridianPlugin = {
  manifest,
  activate: (ctx) => ({
    parsers: [
      {
        domain: DOMAIN,
        sniff,
        ingest: async (src, sink) => {
          if (src.text === undefined) {
            throw new Error(
              `${DOMAIN} parser needs text; "${src.uri}" provided ${src.bytes ? 'binary bytes' : 'no content'}`,
            );
          }
          if (looksBinary(src.text)) {
            throw new Error(`"${src.uri}" is not valid text (NUL or replacement characters)`);
          }
          sink.progress({ stage: 'parse', done: 0 });
          const outline = buildOutline(src.text);
          sink.progress({ stage: 'build', done: 1 });
          sink.emitDocument(buildDocument(ctx, src, outline, VERSION));
        },
      },
    ],
  }),
};
