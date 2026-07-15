import type { ProviderCapabilities } from './types.js';

/**
 * Reference v1 capability catalogs (ARCHITECTURE §8.2 "reference configuration",
 * not an architectural commitment). Pricing is USD per 1,000,000 tokens and is
 * indicative only — the *measured* cost table is committed in Phase 8F, and
 * budget ceilings should be set from those measured numbers. Anthropic is
 * completion-only (no embeddings); OpenAI both completes and embeds, exercising
 * the independent embedding route.
 */
export const ANTHROPIC_REFERENCE_CAPABILITIES: ProviderCapabilities = {
  completion: true,
  embedding: false,
  models: {
    // Extraction & summarization (primary), bulk labeling (economy).
    'claude-opus-4-8': { inputPerMTok: 15, outputPerMTok: 75 },
    'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
  },
};

export const OPENAI_REFERENCE_CAPABILITIES: ProviderCapabilities = {
  completion: true,
  embedding: true,
  models: {
    'gpt-4.1': { inputPerMTok: 2, outputPerMTok: 8 },
    'text-embedding-3-large': { inputPerMTok: 0.13, outputPerMTok: 0 },
  },
};

/**
 * CLI-session provider catalogs (ADR-0035). Pricing is **notional**: a CLI
 * session bills the user's subscription (marginal dollar cost $0), but a
 * zero-price catalog would silently disable every `maxDollars` ceiling
 * (ADR-0032), so BudgetGuard meters what the run *would* cost at reference
 * API rates. Both CLIs are completion-only; embeddings keep their own route.
 */
export const CLAUDE_CLI_REFERENCE_CAPABILITIES: ProviderCapabilities = {
  completion: true,
  embedding: false,
  models: {
    'claude-opus-4-8': { inputPerMTok: 15, outputPerMTok: 75 },
    'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
  },
};

export const CODEX_CLI_REFERENCE_CAPABILITIES: ProviderCapabilities = {
  completion: true,
  embedding: false,
  models: {
    'gpt-5-codex': { inputPerMTok: 1.25, outputPerMTok: 10 },
    'gpt-5': { inputPerMTok: 1.25, outputPerMTok: 10 },
  },
};
