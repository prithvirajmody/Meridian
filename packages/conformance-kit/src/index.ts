/**
 * Adapter conformance (ARCHITECTURE.md §7.4): executable law for the
 * `domain-parser` capability. `describeParserConformance` is a Vitest suite
 * factory written against the *contract*, not any adapter (roadmap Phase 2
 * §9a): IR validity on the corpus, determinism of the skeleton pass, identity
 * stability under re-ingest, AI-freeness, and crash containment.
 *
 * The kit deliberately does not use plugin-host (§20: it may import only
 * plugin-api and graph-core) — it drives the parser exactly the way a host
 * does, through a buffered sink, so a parser that passes here behaves under
 * any compliant host.
 */
import {
  ATTR_KEY_PATTERN,
  decode,
  deriveEdgeId,
  deriveGraphId,
  deriveNodeId,
  encodeCanonical,
  type GraphId,
  type NodeId,
} from '@meridian/graph-core';
import {
  NAMESPACED_KEY_PATTERN,
  PLUGIN_API_VERSION,
  type DeltaWire,
  type DomainParser,
  type GraphDocument,
  type IdFacade,
  type MeridianPlugin,
  type PluginContext,
  type SourceDescriptor,
} from '@meridian/plugin-api';
import { describe, expect, it } from 'vitest';
import type { CorpusEntry } from './corpus.js';
import { vocabularyOf } from './vocabulary.js';

export interface ConformanceOptions {
  readonly plugin: MeridianPlugin;
  readonly corpus: readonly CorpusEntry[];
}

/** graph-core's deterministic ID derivation, shaped as the context facade. */
export function idFacade(): IdFacade {
  return {
    nodeId: (coords) => deriveNodeId(coords) as string,
    graphId: (coords) => deriveGraphId(coords) as string,
    edgeId: (coords) =>
      deriveEdgeId({
        graph: coords.graph as GraphId,
        kind: coords.kind,
        src: coords.src as NodeId,
        dst: coords.dst as NodeId,
        ...(coords.occurrence !== undefined ? { occurrence: coords.occurrence } : {}),
      }) as string,
  };
}

export { vocabularyOf } from './vocabulary.js';

interface Emissions {
  readonly documents: readonly GraphDocument[];
  readonly deltas: readonly DeltaWire[];
}

async function runIngest(parser: DomainParser, src: SourceDescriptor): Promise<Emissions> {
  const documents: GraphDocument[] = [];
  const deltas: DeltaWire[] = [];
  await parser.ingest(src, {
    emitDocument: (doc) => documents.push(doc),
    emitDelta: (delta) => deltas.push(delta),
    progress: () => undefined,
  });
  return { documents, deltas };
}

function conformanceContext(): PluginContext {
  return {
    apiVersion: PLUGIN_API_VERSION,
    ids: idFacade(),
    log: { info: () => undefined, warn: () => undefined },
  };
}

export function describeParserConformance(opts: ConformanceOptions): void {
  const { plugin, corpus } = opts;
  const manifest = plugin.manifest;
  const okEntries = corpus.filter((e) => (e.expect ?? 'ok') === 'ok');
  const rejectEntries = corpus.filter((e) => e.expect === 'reject');

  describe(`domain-parser conformance: ${manifest.name}`, () => {
    const exports = plugin.activate(conformanceContext());
    const parsers = exports.parsers ?? [];
    const declaredDomains = manifest.capabilities
      .filter((c) => c.kind === 'domain-parser')
      .map((c) => c.id);

    describe('manifest & activation', () => {
      it('declares at least one domain-parser capability', () => {
        expect(declaredDomains.length).toBeGreaterThan(0);
      });

      it('exports exactly the declared parsers, domains matching ids', () => {
        expect(parsers.map((p) => p.domain).sort()).toEqual([...declaredDomains].sort());
      });

      it('declares only well-formed, non-core kinds and attr keys', () => {
        // The contract's grammar must be the core's grammar (ADR-0003).
        expect(NAMESPACED_KEY_PATTERN.source).toBe(ATTR_KEY_PATTERN.source);
        for (const kind of manifest.kinds ?? []) {
          expect(kind).toMatch(NAMESPACED_KEY_PATTERN);
          expect(kind.startsWith('core:')).toBe(false);
        }
        for (const key of Object.keys(manifest.attrSchemas ?? {})) {
          expect(key).toMatch(NAMESPACED_KEY_PATTERN);
          expect(key.startsWith('core:')).toBe(false);
        }
      });

      it('activate is repeatable (no hidden state)', () => {
        const again = plugin.activate(conformanceContext());
        expect((again.parsers ?? []).map((p) => p.domain)).toEqual(
          parsers.map((p) => p.domain),
        );
      });
    });

    for (const parser of parsers) {
      describe(`parser "${parser.domain}"`, () => {
        it('sniff is pure, deterministic, and in [0, 1] across the corpus', () => {
          for (const entry of corpus) {
            const a = parser.sniff(entry.source);
            const b = parser.sniff(entry.source);
            expect(a, `sniff(${entry.name}) must be deterministic`).toBe(b);
            expect(Number.isFinite(a), `sniff(${entry.name}) must be finite`).toBe(true);
            expect(a).toBeGreaterThanOrEqual(0);
            expect(a).toBeLessThanOrEqual(1);
          }
        });

        it('claims every ok corpus entry', () => {
          for (const entry of okEntries) {
            expect(
              parser.sniff(entry.source),
              `sniff(${entry.name}) must be > 0 for a corpus source`,
            ).toBeGreaterThan(0);
          }
        });

        for (const entry of okEntries) {
          it(`ingests "${entry.name}" gate-clean, deterministically, AI-free`, async () => {
            const first = await runIngest(parser, entry.source);
            expect(
              first.documents.length + first.deltas.length,
              'an ok ingest must emit at least one document or delta',
            ).toBeGreaterThan(0);

            const vocabulary = vocabularyOf(manifest);
            for (const doc of first.documents) {
              // The IR gate (§6.4): structural + semantic + U8, all errors located.
              const gate = decode(doc, { vocabulary });
              expect(
                gate.ok ? [] : gate.errors,
                `document from "${entry.name}" must pass the IR gate`,
              ).toEqual([]);
              if (!gate.ok) continue;

              // Skeleton passes are AI-free (§7.2.3): nothing may carry ai origin.
              for (const g of gate.space.graphs.values()) {
                expect(g.meta.provenance.origin).not.toBe('ai');
                for (const n of g.nodes.values()) expect(n.provenance.origin).not.toBe('ai');
                for (const e of g.edges.values()) expect(e.provenance.origin).not.toBe('ai');
              }
            }

            // Determinism + identity stability (P6, U4): re-ingest of the
            // unchanged source is byte-identical — which pins IDs too.
            const second = await runIngest(parser, entry.source);
            expect(second.documents.length).toBe(first.documents.length);
            expect(second.deltas.length).toBe(first.deltas.length);
            for (let i = 0; i < first.documents.length; i++) {
              const a = decode(first.documents[i]!);
              const b = decode(second.documents[i]!);
              expect(a.ok && b.ok).toBe(true);
              if (a.ok && b.ok) {
                expect(encodeCanonical(b.space)).toBe(encodeCanonical(a.space));
              }
            }
            expect(JSON.stringify(second.deltas)).toBe(JSON.stringify(first.deltas));
          });
        }

        if (rejectEntries.length > 0) {
          it('fails rejectable inputs with an Error, and stays usable', async () => {
            for (const entry of rejectEntries) {
              await expect(
                runIngest(parser, entry.source),
                `"${entry.name}" must be rejected`,
              ).rejects.toThrow();
            }
            // Crash containment (§7.4): a failed ingest never poisons the parser.
            if (okEntries.length > 0) {
              const retry = await runIngest(parser, okEntries[0]!.source);
              expect(retry.documents.length + retry.deltas.length).toBeGreaterThan(0);
            }
          });
        }
      });
    }
  });
}

export { loadCorpusDir } from './corpus.js';
export type { CorpusEntry, LoadCorpusOptions } from './corpus.js';
export { describeIncrementalConformance } from './incremental.js';
export type {
  IncrementalConformanceOptions,
  IncrementalEdit,
  IncrementalScenario,
  IncrementalSession,
  ScenarioFile,
} from './incremental.js';
