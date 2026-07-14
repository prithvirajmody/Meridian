/**
 * Versioned prompt for naming + summarizing one rollup (cluster) node
 * (subphase 8D). Prompts are values, never inline literals (§8.3): `render`
 * is a pure function of its input and `version` must bump whenever the
 * rendered text changes for a fixed input — that is what invalidates the
 * replay cache and re-keys provenance (ADR-0030).
 */
import { definePromptSpec, type PromptSpec } from '@meridian/ai';
import { rollupSummarySchema, type RollupSummaryOutput } from '../schemas.js';

/** One member's salient, order-independent facts for the prompt. */
export interface MemberDigest {
  readonly kind: string;
  readonly label: string;
}

/**
 * The deterministic projection the prompt renders from. Only fields that
 * affect the rendered text belong here (they define the `inputHash`): the
 * domain, the member digests (already sorted by the caller for stability),
 * and the true member count when the digest was capped for prompt size.
 */
export interface RollupPromptInput {
  readonly domain: string;
  readonly members: readonly MemberDigest[];
  readonly totalMembers: number;
}

function renderMembers(members: readonly MemberDigest[]): string {
  return members.map((m) => `- (${m.kind}) ${m.label}`).join('\n');
}

export const SUMMARIZE_ROLLUP_PROMPT: PromptSpec<RollupPromptInput, RollupSummaryOutput> =
  definePromptSpec<RollupPromptInput, RollupSummaryOutput>({
    id: 'ai-services:summarize-rollup',
    version: '1',
    taskClass: 'summarization',
    schema: rollupSummarySchema,
    maxOutputTokens: 512,
    temperature: 0,
    render: (input) => ({
      system:
        'You name and summarize a group of related items from a knowledge graph. ' +
        'Return a short human-readable name (a few words, no trailing punctuation) ' +
        'and a single-sentence summary of what the group is about. ' +
        'Base both only on the members shown; do not invent facts. ' +
        'confidence is your calibrated certainty in [0,1] that the name fits the group.',
      messages: [
        {
          role: 'user',
          content:
            `Domain: ${input.domain}\n` +
            `Members (${input.totalMembers} total` +
            (input.members.length < input.totalMembers
              ? `, showing ${input.members.length}`
              : '') +
            `):\n${renderMembers(input.members)}`,
        },
      ],
    }),
  });
