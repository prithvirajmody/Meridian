/**
 * The offline mock extraction provider for the argmap eval (Phase 9D).
 *
 * The gateway renders EXTRACT_STRUCTURE_PROMPT with the source text as the
 * user message; this mock answers with a deterministic, schema-valid
 * extraction: up to two claim-worthy sentences (≥ 24 chars) become an
 * `arg:claim` and an `arg:premise`, joined by one `arg:supports` edge — the
 * same rule the CLI's mock provider uses, so harness and CLI agree offline.
 *
 * It does NOT stand in for model *quality*: sentence echoing is not argument
 * mining. Real, scoreable argument maps come from the live/record path
 * (evals/README.md); this mock only proves determinism and structure.
 */
import { MockProvider } from '../../packages/ai/dist/index.js';

export const MOCK_EXTRACT_PROVIDER_ID = 'fake-extract';
export const MOCK_EXTRACT_MODEL = 'fake-extract-1';

/** Deterministic extraction from a rendered extract-structure request. */
export function deriveExtraction(system, userContent) {
  const domain = /"([a-z][a-z0-9-]*):name"/.exec(system ?? '')?.[1] ?? 'core';
  const sentences = userContent
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 24);
  const kinds = domain === 'arg' ? ['claim', 'premise'] : ['claim', 'claim'];
  const nodes = sentences.slice(0, 2).map((s, i) => ({
    id: `${domain}:c-${i + 1}`,
    kind: `${domain}:${kinds[i]}`,
    label: s.length > 120 ? `${s.slice(0, 119)}…` : s,
  }));
  const edgeKind = domain === 'arg' ? 'supports' : 'refers-back';
  const edges =
    nodes.length === 2
      ? [{ id: `${domain}:r-1`, src: `${domain}:c-2`, dst: `${domain}:c-1`, kind: `${domain}:${edgeKind}` }]
      : [];
  return { nodes, edges };
}

export function mockExtractProvider(id = MOCK_EXTRACT_PROVIDER_ID, model = MOCK_EXTRACT_MODEL) {
  return new MockProvider({
    id,
    capabilities: { completion: true, embedding: false, models: { [model]: { inputPerMTok: 1, outputPerMTok: 1 } } },
    onComplete: (request) => ({
      kind: 'json',
      value: deriveExtraction(request.system, request.messages.map((m) => m.content).join('\n')),
    }),
  });
}
