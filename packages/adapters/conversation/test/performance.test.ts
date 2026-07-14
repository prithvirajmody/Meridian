/**
 * Skeleton ingest scale (ROADMAP Phase 9B exit): a 1000-message conversation
 * ingests through the real plugin parser in well under 3000 ms, emitting a
 * structurally complete document. The synthetic export is generated *before*
 * the clock starts; only parse + build (the skeleton pass) is measured. The
 * threshold is a hard gate — it is asserted, never skipped or softened.
 */
import { idFacade } from '@meridian/conformance-kit';
import {
  PLUGIN_API_VERSION,
  type GraphDocument,
  type IngestSink,
  type PluginContext,
} from '@meridian/plugin-api';
import { describe, expect, it } from 'vitest';
import { conversationPlugin } from '../src/index.js';

const ctx: PluginContext = {
  apiVersion: PLUGIN_API_VERSION,
  ids: idFacade(),
  log: { info: () => undefined, warn: () => undefined },
};

const MESSAGES = 1000;
const BUDGET_MS = 3000;

/** A deterministic 1000-message Claude export as raw JSON text. */
function generateExport(n: number): string {
  const messages: unknown[] = [];
  for (let i = 0; i < n; i += 1) {
    messages.push({
      uuid: `m-${i}`,
      sender: i % 2 === 0 ? 'human' : 'assistant',
      text: `Message ${i}: a representative line of conversation content for load.`,
      created_at: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
      ...(i > 0 ? { parent_message_uuid: `m-${i - 1}` } : {}),
    });
  }
  return JSON.stringify([{ uuid: 'perf-conv', name: 'Perf', chat_messages: messages }]);
}

function messageNodeCount(doc: GraphDocument): number {
  return doc.graphs.reduce(
    (sum, g) => sum + g.nodes.filter((n) => n.kind === 'conv:message').length,
    0,
  );
}

describe('performance — 1000-message ingest', () => {
  it(`parses and builds ${MESSAGES} messages in under ${BUDGET_MS} ms`, async () => {
    const text = generateExport(MESSAGES); // fixture generation — not timed
    const parser = conversationPlugin.activate(ctx).parsers![0]!;

    const documents: GraphDocument[] = [];
    const sink: IngestSink = {
      emitDocument: (d) => documents.push(d),
      emitDelta: () => undefined,
      progress: () => undefined,
    };

    const start = performance.now();
    await parser.ingest({ uri: 'perf.json', text }, sink);
    const elapsed = performance.now() - start;

    // The document is emitted and structurally complete...
    expect(documents).toHaveLength(1);
    const doc = documents[0]!;
    expect(doc.graphs.length).toBeGreaterThan(1);
    expect(messageNodeCount(doc)).toBe(MESSAGES);

    // ...and the skeleton pass is strictly under the hard budget.
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });
});
