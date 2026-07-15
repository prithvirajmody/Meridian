/**
 * Host behavior (roadmap Phase 2 §12): manifest validation, capability
 * resolution, sniff arbitration, and — the failure rows — apiVersion
 * mismatch, two parsers claiming one source, and a parser throwing
 * mid-stream (atomic rollback, host unpoisoned).
 */
import {
  PLUGIN_API_VERSION,
  type DomainParser,
  type GraphDocument,
  type IdFacade,
  type MeridianPlugin,
  type PluginManifest,
  type SourceDescriptor,
} from '@meridian/plugin-api';
import { describe, expect, it } from 'vitest';
import { createPluginHost } from '../src/host.js';

/** Test double: real derivation lives in graph-core, injected by the app —
 * the host contract only needs *some* deterministic facade. */
const ids: IdFacade = {
  nodeId: (c) => `n:${c.domain}/${c.source}/${c.path.join('/')}`,
  graphId: (c) => `g:${c.domain}/${c.source}/${c.path.join('/')}`,
  edgeId: (c) => `e:${c.graph}/${c.kind}/${c.src}/${c.dst}`,
};

const doc = (graphId: string): GraphDocument => ({
  formatVersion: 1,
  producer: { name: 'test', version: '0' },
  roots: [graphId],
  graphs: [
    {
      id: graphId,
      meta: { label: '', domain: 'lines', provenance: { origin: 'source' } },
      nodes: [
        {
          id: `${graphId}-n1`,
          kind: 'lines:item',
          label: 'one',
          provenance: { origin: 'source' },
        },
      ],
      edges: [],
    },
  ],
});

function manifest(over: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: 'test-plugin',
    version: '0.1.0',
    apiVersion: `^${PLUGIN_API_VERSION}`,
    capabilities: [{ kind: 'domain-parser', id: 'lines' }],
    kinds: ['lines:item'],
    attrSchemas: { 'lines:count': { type: 'number', description: 'line count' } },
    ...over,
  };
}

function parser(over: Partial<DomainParser> = {}): DomainParser {
  return {
    domain: 'lines',
    sniff: (src) => (src.uri.endsWith('.lines') ? 0.8 : 0),
    ingest: async (src, sink) => {
      sink.emitDocument(doc(`g-${src.uri}`));
    },
    ...over,
  };
}

function plugin(m: Partial<PluginManifest> = {}, p: Partial<DomainParser> = {}): MeridianPlugin {
  return { manifest: manifest(m), activate: () => ({ parsers: [parser(p)] }) };
}

const SRC: SourceDescriptor = { uri: 'a.lines', text: 'one\n' };

describe('registration', () => {
  it('registers a valid plugin and aggregates its vocabulary', () => {
    const host = createPluginHost({ ids });
    const r = host.register(plugin());
    expect(r.ok).toBe(true);
    expect(host.plugins()).toHaveLength(1);
    expect(host.vocabulary().kinds.has('lines:item')).toBe(true);
    expect(host.vocabulary().attrs.get('lines:count')).toBe('number');
  });

  it('rejects a malformed manifest with aggregated, located errors', () => {
    const host = createPluginHost({ ids });
    const r = host.register(
      plugin({ version: 'one', apiVersion: '>=0.1.0', capabilities: [] }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issue.code).toBe('invalid-manifest');
      expect(r.issue.message).toContain('version');
      expect(r.issue.message).toContain('apiVersion');
      expect(r.issue.message).toContain('capabilities');
    }
    expect(host.plugins()).toHaveLength(0);
  });

  it('rejects unknown capability kinds (ADR-0011: closed enum)', () => {
    const host = createPluginHost({ ids });
    const r = host.register(
      plugin({ capabilities: [{ kind: 'time-travel' as never, id: 'x' }] }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issue.code).toBe('invalid-manifest');
  });

  it('rejects core-namespace vocabulary claims', () => {
    const host = createPluginHost({ ids });
    const r = host.register(plugin({ kinds: ['core:cluster'] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issue.code).toBe('invalid-manifest');
  });

  it('rejects an incompatible apiVersion range without activating', () => {
    const host = createPluginHost({ ids });
    let activated = false;
    const p: MeridianPlugin = {
      manifest: manifest({ apiVersion: '^9.9.9' }),
      activate: () => {
        activated = true;
        return { parsers: [parser()] };
      },
    };
    const r = host.register(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issue.code).toBe('api-version-incompatible');
    expect(activated).toBe(false);
  });

  it('rejects duplicate plugin names', () => {
    const host = createPluginHost({ ids });
    expect(host.register(plugin()).ok).toBe(true);
    const r = host.register(plugin());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issue.code).toBe('duplicate-plugin');
  });

  it('contains a throwing activate (host unaffected)', () => {
    const host = createPluginHost({ ids });
    const r = host.register({
      manifest: manifest(),
      activate: () => {
        throw new Error('boom at activation');
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issue.code).toBe('activation-failed');
      expect(r.issue.message).toContain('boom at activation');
    }
    expect(host.register(plugin({ name: 'other' })).ok).toBe(true);
  });

  it('rejects exports that do not match declared domain-parser capabilities', () => {
    const host = createPluginHost({ ids });
    const r = host.register({
      manifest: manifest(),
      activate: () => ({ parsers: [parser({ domain: 'other' })] }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issue.code).toBe('exports-mismatch');
      expect(r.issue.message).toContain('lines');
      expect(r.issue.message).toContain('other');
    }
  });

  it('rejects conflicting attr schema declarations across plugins', () => {
    const host = createPluginHost({ ids });
    expect(host.register(plugin()).ok).toBe(true);
    const r = host.register(
      plugin(
        {
          name: 'conflicting',
          capabilities: [{ kind: 'domain-parser', id: 'conflict' }],
          attrSchemas: { 'lines:count': { type: 'string', description: 'oops' } },
        },
        { domain: 'conflict' },
      ),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issue.code).toBe('vocabulary-conflict');
  });

  it('accepts declared-but-dormant capability kinds (ADR-0011)', () => {
    const host = createPluginHost({ ids });
    const r = host.register(
      plugin({
        capabilities: [
          { kind: 'domain-parser', id: 'lines' },
          { kind: 'abstraction-provider', id: 'rollup' },
        ],
      }),
    );
    expect(r.ok).toBe(true);
  });
});

describe('sniff arbitration', () => {
  it('ranks positive claimants best-first and drops zero scores', () => {
    const host = createPluginHost({ ids });
    host.register(plugin({ name: 'a' }, { sniff: () => 0.9 }));
    host.register(
      plugin(
        { name: 'b', capabilities: [{ kind: 'domain-parser', id: 'weak' }] },
        { domain: 'weak', sniff: () => 0.3 },
      ),
    );
    host.register(
      plugin(
        { name: 'c', capabilities: [{ kind: 'domain-parser', id: 'no' }] },
        { domain: 'no', sniff: () => 0 },
      ),
    );
    const r = host.resolve(SRC);
    expect(r.candidates.map((c) => c.parser.domain)).toEqual(['lines', 'weak']);
  });

  it('scores a throwing or non-finite sniff as 0, with a warning', () => {
    const host = createPluginHost({ ids });
    host.register(
      plugin(
        {},
        {
          sniff: () => {
            throw new Error('sniff exploded');
          },
        },
      ),
    );
    host.register(
      plugin(
        { name: 'nan', capabilities: [{ kind: 'domain-parser', id: 'nn' }] },
        { domain: 'nn', sniff: () => Number.NaN },
      ),
    );
    const r = host.resolve(SRC);
    expect(r.candidates).toEqual([]);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toContain('sniff exploded');
  });

  it('clamps out-of-range scores into [0, 1]', () => {
    const host = createPluginHost({ ids });
    host.register(plugin({}, { sniff: () => 7 }));
    const r = host.resolve(SRC);
    expect(r.candidates[0]?.score).toBe(1);
  });
});

describe('ingest', () => {
  it('selects the best claimant and reports counts + provenance tally', async () => {
    const host = createPluginHost({ ids });
    host.register(plugin());
    const out = await host.ingest(SRC);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.domain).toBe('lines');
      expect(out.documents).toHaveLength(1);
      expect(out.report.graphs).toBe(1);
      expect(out.report.nodes).toBe(1);
      expect(out.report.provenance).toEqual({ source: 2, derived: 0, ai: 0 });
    }
  });

  it('fails when nothing claims the source', async () => {
    const host = createPluginHost({ ids });
    host.register(plugin());
    const out = await host.ingest({ uri: 'a.bin' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.issue.code).toBe('no-parser');
  });

  it('refuses a tie between two claimants (explicit choice required)', async () => {
    const host = createPluginHost({ ids });
    host.register(plugin({ name: 'a' }, { sniff: () => 0.8 }));
    host.register(
      plugin(
        { name: 'b', capabilities: [{ kind: 'domain-parser', id: 'rival' }] },
        { domain: 'rival', sniff: () => 0.8 },
      ),
    );
    const out = await host.ingest(SRC);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.issue.code).toBe('ambiguous-source');
      expect(out.issue.message).toContain('lines');
      expect(out.issue.message).toContain('rival');
    }
    // …and the explicit choice resolves it.
    const forced = await host.ingest(SRC, { parser: 'rival' });
    expect(forced.ok).toBe(true);
  });

  it('forcing an unknown parser is a typed failure', async () => {
    const host = createPluginHost({ ids });
    host.register(plugin());
    const out = await host.ingest(SRC, { parser: 'nope' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.issue.code).toBe('unknown-parser');
  });

  it('discards partial emissions when the parser throws mid-stream', async () => {
    const host = createPluginHost({ ids });
    host.register(
      plugin(
        {},
        {
          ingest: async (src, sink) => {
            sink.emitDocument(doc('g-partial-1'));
            sink.emitDocument(doc('g-partial-2'));
            throw new Error('parser died mid-stream');
          },
        },
      ),
    );
    const out = await host.ingest(SRC);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.issue.code).toBe('ingest-failed');
      expect(out.issue.message).toContain('2 document(s)');
      expect(out.issue.message).toContain('nothing was kept');
      expect(out.issue.message).toContain('parser died mid-stream');
    }
  });

  it('a failed ingest does not poison the host (next ingest succeeds)', async () => {
    const host = createPluginHost({ ids });
    let calls = 0;
    host.register(
      plugin(
        {},
        {
          ingest: async (src, sink) => {
            calls += 1;
            if (calls === 1) throw new Error('first call fails');
            sink.emitDocument(doc('g-ok'));
          },
        },
      ),
    );
    expect((await host.ingest(SRC)).ok).toBe(false);
    expect((await host.ingest(SRC)).ok).toBe(true);
  });

  it('emissions after ingest resolves are refused (sink closed)', async () => {
    const host = createPluginHost({ ids });
    let leakedSink: { emitDocument(d: GraphDocument): void } | undefined;
    host.register(
      plugin(
        {},
        {
          ingest: async (_src, sink) => {
            leakedSink = sink;
            sink.emitDocument(doc('g-live'));
          },
        },
      ),
    );
    const out = await host.ingest(SRC);
    expect(out.ok).toBe(true);
    expect(() => leakedSink!.emitDocument(doc('g-late'))).toThrow(/closed/);
    if (out.ok) expect(out.documents).toHaveLength(1);
  });

  it('streams progress through to the caller', async () => {
    const host = createPluginHost({ ids });
    host.register(
      plugin(
        {},
        {
          ingest: async (_src, sink) => {
            sink.progress({ stage: 'parse', done: 1, total: 2 });
            sink.emitDocument(doc('g-p'));
            sink.progress({ stage: 'emit', done: 2, total: 2 });
          },
        },
      ),
    );
    const seen: string[] = [];
    const out = await host.ingest(SRC, { onProgress: (p) => seen.push(p.stage) });
    expect(out.ok).toBe(true);
    expect(seen).toEqual(['parse', 'emit']);
  });
});

describe('view-projection capability (ADR-0037, 1.1.0)', () => {
  const projection = (id: string): import('@meridian/plugin-api').ViewProjectionExport => ({
    id,
    label: id,
    suitability: () => 0.5,
    mount: async () => {
      throw new Error('never mounted by the host');
    },
  });

  function projectionPlugin(
    name: string,
    declared: readonly string[],
    exported: readonly string[] = declared,
  ): MeridianPlugin {
    return {
      manifest: manifest({
        name,
        capabilities: [
          { kind: 'domain-parser', id: 'lines' },
          ...declared.map((id) => ({ kind: 'view-projection' as const, id })),
        ],
      }),
      activate: () => ({
        parsers: [parser()],
        viewProjections: exported.map(projection),
      }),
    };
  }

  it('registers declared projections and resolves them in deterministic order', () => {
    const host = createPluginHost({ ids });
    expect(host.register(projectionPlugin('p-one', ['sunburst', 'chord'])).ok).toBe(true);
    expect(
      host.register({
        manifest: manifest({
          name: 'p-two',
          capabilities: [
            { kind: 'domain-parser', id: 'other' },
            { kind: 'view-projection', id: 'ribbon' },
          ],
        }),
        activate: () => ({
          parsers: [parser({ domain: 'other' })],
          viewProjections: [projection('ribbon')],
        }),
      }).ok,
    ).toBe(true);

    expect(
      host.viewProjections().map((r) => [r.plugin, r.projection.id]),
    ).toEqual([
      ['p-one', 'sunburst'],
      ['p-one', 'chord'],
      ['p-two', 'ribbon'],
    ]);
  });

  it('refuses declared-but-not-exported and exported-but-not-declared projections', () => {
    const host = createPluginHost({ ids });
    const missing = host.register(projectionPlugin('p-missing', ['sunburst'], []));
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.issue.code).toBe('exports-mismatch');
      expect(missing.issue.message).toContain('declared but not exported: sunburst');
    }

    const undeclared = host.register(projectionPlugin('p-undeclared', [], ['rogue']));
    expect(undeclared.ok).toBe(false);
    if (!undeclared.ok) {
      expect(undeclared.issue.code).toBe('exports-mismatch');
      expect(undeclared.issue.message).toContain('exported but not declared: rogue');
    }
    expect(host.viewProjections()).toHaveLength(0);
  });

  it('rejects a duplicate projection id across plugins without poisoning the host', () => {
    const host = createPluginHost({ ids });
    expect(host.register(projectionPlugin('p-first', ['sunburst'])).ok).toBe(true);
    const duplicate = host.register({
      manifest: manifest({
        name: 'p-dup',
        capabilities: [
          { kind: 'domain-parser', id: 'other' },
          { kind: 'view-projection', id: 'sunburst' },
        ],
      }),
      activate: () => ({
        parsers: [parser({ domain: 'other' })],
        viewProjections: [projection('sunburst')],
      }),
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.issue.code).toBe('capability-conflict');
      expect(duplicate.issue.message).toContain('"sunburst"');
      expect(duplicate.issue.message).toContain('p-first');
    }
    expect(host.viewProjections()).toHaveLength(1);
    expect(host.plugins().map((p) => p.manifest.name)).toEqual(['p-first']);
  });
});
