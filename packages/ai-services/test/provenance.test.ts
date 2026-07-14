/**
 * The provenance quartet is the ADR-0030 replay key carried from a gateway
 * result onto a proposal. `provenanceOfCall` mirrors the completion's own
 * `promptVersion`; `provenanceOfEmbed` fixes it to `'embedding'` (embeddings
 * are not rendered from a versioned PromptSpec) so an embedding-derived cluster
 * still names a reproducible call.
 */
import { EMBEDDING_PROMPT_VERSION, type AiCallResult, type AiEmbedResult } from '@meridian/ai';
import { describe, expect, it } from 'vitest';
import { provenanceOfCall, provenanceOfEmbed } from '../src/provenance.js';

const usage = { inputTokens: 1, outputTokens: 1 };

describe('provenanceOfCall', () => {
  it('extracts the four-field replay key from a completion result', () => {
    const result: AiCallResult<unknown> = {
      value: {},
      stopReason: 'stop',
      usage,
      providerId: 'anthropic',
      model: 'claude-opus-4-8',
      promptId: 'ai-services:summarize-rollup',
      promptVersion: '3',
      inputHash: 'abc',
      cached: false,
      repaired: false,
    };
    expect(provenanceOfCall(result)).toEqual({
      providerId: 'anthropic',
      model: 'claude-opus-4-8',
      promptVersion: '3',
      inputHash: 'abc',
    });
  });
});

describe('provenanceOfEmbed', () => {
  it('keys embeddings under the fixed "embedding" promptVersion', () => {
    const result: AiEmbedResult = {
      vectors: [[1, 0]],
      usage,
      providerId: 'openai',
      model: 'text-embedding-3-small',
      inputHash: 'def',
      cached: true,
    };
    expect(provenanceOfEmbed(result)).toEqual({
      providerId: 'openai',
      model: 'text-embedding-3-small',
      promptVersion: EMBEDDING_PROMPT_VERSION,
      inputHash: 'def',
    });
  });
});
