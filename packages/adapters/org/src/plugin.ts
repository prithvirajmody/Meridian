/**
 * `@meridian/adapter-org` as a Meridian plugin (ADR-0047, AutoBuild roadmap
 * Phase 14A/14B): AutoBuild `org-bundle-v1` / `org-definition-v1` documents →
 * a deterministic org → team → role → assignment → artifact skeleton.
 * Deterministic, AI-free, isomorphic in `src` (no `node:*`, no DOM, no
 * network, no store): it sees only `plugin-api` (§20) and JSON is native. One
 * export, no module-scope side effects (ADR-0009); `activate` returns the
 * parser, importing this module does nothing.
 *
 * `apiVersion` targets caret `^1.0.0` (the 9E freeze, ADR-0033). Temporal
 * facts are declared node attrs (`org:started-at` / `org:ended-at`, lane
 * `org:lane`) so the timeline projection renders run swimlanes without ever
 * naming this domain (ADR-0037).
 */
import type { MeridianPlugin, PluginManifest, SourceDescriptor } from '@meridian/plugin-api';
import { buildDocument, DOMAIN } from './document.js';
import { OrgParseError } from './errors.js';
import {
  BUNDLE_SCHEMA_VERSION,
  containsNul,
  DEFINITION_SCHEMA_VERSION,
  parseOrgSource,
} from './parse.js';

const VERSION = '0.1.0';

export const manifest: PluginManifest = {
  name: '@meridian/adapter-org',
  version: VERSION,
  apiVersion: '^1.0.0',
  capabilities: [{ kind: 'domain-parser', id: DOMAIN }],
  kinds: [
    'org:organization',
    'org:team',
    'org:role-instance',
    'org:gate',
    'org:assignment',
    'org:event',
    'org:artifact',
    'org:then',
    'org:feeds',
    'org:reviewed-by',
    'org:escalates-to',
    'org:gates',
    'org:produced',
  ],
  attrSchemas: {
    'org:id': { type: 'string', description: 'organization id from the definition' },
    'org:version': { type: 'string', description: 'organization semver from the definition' },
    'org:digest': { type: 'string', description: 'canonical self-digest of the org definition' },
    'org:brain-store': { type: 'string', description: 'registered brain store the org binds to' },
    'org:brain-root-ref': { type: 'string', description: 'brain root reference the org binds to' },
    'org:index': { type: 'number', description: '0-based order of an element within its collection' },
    'org:implicit': {
      type: 'boolean',
      description: 'true on nodes the adapter synthesizes for uniform depth (_direct team, _system instance)',
    },
    'org:template-ref': { type: 'string', description: 'team template a team was stamped from' },
    'org:role-type': { type: 'string', description: 'declared role type of an instance' },
    'org:engine': { type: 'string', description: 'per-instance engine override, when declared' },
    'org:row-kind': { type: 'string', description: 'workflow row kind an edge derives from' },
    'org:verdict': { type: 'string', description: 'verdict selecting a conditional workflow edge' },
    'org:input': { type: 'string', description: 'artifact kind a feeds/gates edge carries' },
    'org:via-src': { type: 'string', description: 'deep source node id of a portal-rebased edge' },
    'org:via-dst': { type: 'string', description: 'deep destination node id of a portal-rebased edge' },
    'org:job-id': { type: 'string', description: 'AutoBuild job id an assignment belongs to' },
    'org:org-digest': { type: 'string', description: 'org digest the job was pinned to at mint' },
    'org:lane': { type: 'string', description: 'owning role instance id (timeline swimlane)' },
    'org:state': {
      type: 'string',
      description:
        'conservative assignment state: in_progress | awaiting_answer | delivered | accepted | escalated',
    },
    'org:started-at': { type: 'string', description: 'ISO-8601 start instant of an element' },
    'org:ended-at': { type: 'string', description: 'ISO-8601 end instant of an element' },
    'org:seq': { type: 'number', description: 'globally monotonic run-log ordinal of an event' },
    'org:kind': { type: 'string', description: 'closed event kind from org-run-events-v1' },
    'org:raw': { type: 'string', description: 'raw run-log event literal' },
    'org:detail': { type: 'string', description: 'redacted run-log detail string, verbatim' },
  },
  levelChain: {
    domain: DOMAIN,
    levels: [
      { name: 'org' },
      { name: 'team' },
      { name: 'role' },
      { name: 'assignment' },
      { name: 'artifact' },
    ],
  },
  // ADR-0037: presentation consumes declared metadata; the timeline never
  // checks for the word "org" or imports this adapter.
  presentation: {
    temporal: {
      startAttribute: 'org:started-at',
      endAttribute: 'org:ended-at',
      laneAttribute: 'org:lane',
    },
  },
};

/**
 * Bounded, conservative source sniff (pure): claim only the two AutoBuild org
 * schema_version markers, in the head window. Arbitrary JSON scores 0 — the
 * adapter never outranks a real domain parser on unrelated data — while an
 * explicit `--adapter org` still ingests anything `parseOrgSource` accepts.
 */
const SNIFF_WINDOW = 1 << 16;
function sniff(src: SourceDescriptor): number {
  if (src.text === undefined || containsNul(src.text)) return 0;
  const head = src.text.slice(0, SNIFF_WINDOW);
  const bundle = head.includes(`"${BUNDLE_SCHEMA_VERSION}"`);
  const definition = head.includes(`"${DEFINITION_SCHEMA_VERSION}"`);
  return bundle || definition ? 0.95 : 0;
}

export const orgPlugin: MeridianPlugin = {
  manifest,
  activate: (ctx) => ({
    parsers: [
      {
        domain: DOMAIN,
        sniff,
        ingest: async (src, sink) => {
          if (src.text === undefined) {
            throw new OrgParseError(
              `parser needs text; ${src.bytes ? 'binary bytes' : 'no content'} provided`,
              { uri: src.uri },
            );
          }
          sink.progress({ stage: 'parse', done: 0 });
          const ir = parseOrgSource(src.text, src.uri);
          sink.progress({ stage: 'build', done: 1 });
          sink.emitDocument(buildDocument(ctx, src, ir, VERSION));
        },
      },
    ],
  }),
};
