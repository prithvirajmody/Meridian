/**
 * The offline mock summarization provider for the eval harness (Phase 8F).
 *
 * The gateway renders SUMMARIZE_ROLLUP_PROMPT into `- (kind) label` member
 * lines; this mock parses them back out and produces a deterministic,
 * structurally-valid name + one-sentence summary grounded in those members. It
 * exercises the whole summarize→propose plumbing and lets the harness gate on
 * structural regressions offline with zero network.
 *
 * It does NOT stand in for model *quality*: a canned summary is not worth a
 * human rating. Real, rateable summaries come from the live/record path
 * (evals/README.md); this mock only proves determinism and structure.
 */
import { MockProvider } from '../../packages/ai/dist/index.js';

const MEMBER_LINE = /^- \(([a-z][a-z0-9-]*:[a-z][a-z0-9-]*)\) (.+)$/;

function shortKindName(kind) {
  const name = kind.split(':')[1] ?? kind;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Derive a deterministic { name, summary, confidence } from a rendered prompt. */
export function deriveSummary(userContent) {
  const members = [];
  for (const line of userContent.split('\n')) {
    const m = MEMBER_LINE.exec(line.trim());
    if (m) members.push({ kind: m[1], label: m[2] });
  }
  const total = members.length || 1;
  // Dominant kind (ties by name) → the name; first labels → the summary.
  const counts = new Map();
  for (const mem of members) counts.set(mem.kind, (counts.get(mem.kind) ?? 0) + 1);
  let dominant = members[0]?.kind ?? 'core:node';
  let best = -1;
  for (const [kind, count] of [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (count > best) {
      best = count;
      dominant = kind;
    }
  }
  const labels = members.slice(0, 3).map((mem) => mem.label.split(/[\s(]/)[0]);
  const rest = total - labels.length;
  const name = `${shortKindName(dominant)} group`;
  const summary =
    rest > 0
      ? `Groups ${total} related ${shortKindName(dominant).toLowerCase()} items including ${labels.join(', ')} and ${rest} more.`
      : `Groups ${total} related items: ${labels.join(', ')}.`;
  return { name: name.slice(0, 80), summary: summary.slice(0, 400), confidence: 0.72 };
}

/** A completion-only MockProvider that answers the rollup prompt deterministically. */
export function mockSummarizeProvider(id = 'mock-complete', model = 'mock-complete-1') {
  return new MockProvider({
    id,
    capabilities: {
      completion: true,
      embedding: false,
      models: { [model]: { inputPerMTok: 3, outputPerMTok: 15 } },
    },
    onComplete: (request) => {
      const userMsg = [...request.messages].reverse().find((m) => m.role === 'user');
      const content = typeof userMsg?.content === 'string' ? userMsg.content : '';
      return { kind: 'json', value: deriveSummary(content) };
    },
  });
}

export const MOCK_COMPLETE_MODEL = 'mock-complete-1';
export const MOCK_COMPLETE_PROVIDER_ID = 'mock-complete';
