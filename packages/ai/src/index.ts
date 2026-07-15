/**
 * @meridian/ai — the AI gateway (ROADMAP Phase 8, ARCHITECTURE §8).
 *
 * One vendor-neutral `AiProvider` seam and an `AiSession` pipeline
 * (cache/replay → budget → provider → zod validate → one repair → typed
 * rejection). Concrete `AnthropicProvider` and `OpenAiProvider` adapters are
 * first-class; `MockProvider` drives offline tests. Vendor SDK imports are
 * confined to `providers/*-client.ts` (§20); keys enter only from env/config
 * edges, never graph documents.
 */

// Core types
export type {
  CompletionRequest,
  CompletionResult,
  EmbeddingRequest,
  EmbeddingResult,
  JsonSchema,
  Message,
  ModelId,
  ModelPricing,
  ProviderCapabilities,
  ProviderId,
  Role,
  StopReason,
  TaskClass,
  Usage,
} from './types.js';

// Errors
export { AiError, isAiError } from './errors.js';
export type { AiErrorContext, AiErrorKind } from './errors.js';

// Provider seam
export type { AiProvider } from './provider.js';

// Prompt specs
export { definePromptSpec } from './prompt-spec.js';
export type { PromptSpec, RenderedPrompt } from './prompt-spec.js';

// Schema bridge
export { zodToJsonSchema } from './schema.js';

// Budget
export { BudgetGuard, costOf, DEFAULT_WARN_THRESHOLD } from './budget.js';
export type { BudgetLimits, BudgetState, BudgetStatus } from './budget.js';

// Retry
export {
  backoffDelay,
  DEFAULT_RETRY_POLICY,
  realSleeper,
  withRetry,
} from './retry.js';
export type { RetryPolicy, Sleeper } from './retry.js';

// Store / cache / replay
export { deriveKeyHash, EMBEDDING_PROMPT_VERSION, MemoryResponseStore } from './store.js';
export type { ResponseKey, ResponseStore, SessionMode, StoredResponse } from './store.js';

// Config & routing
export { pricingFor, resolveRoute, validateConfig } from './config.js';
export type { AiConfig, RouteTarget } from './config.js';

// Hashing
export { canonicalInputHash, canonicalJson, hashString } from './hash.js';

// Session
export { AiSession, createAiSession } from './session.js';
export type { AiCallResult, AiEmbedResult, AiSessionOptions } from './session.js';

// Mock provider (offline testing)
export { MockProvider } from './mock-provider.js';
export type {
  MockCompletionHandler,
  MockEmbeddingHandler,
  MockOutcome,
  MockProviderOptions,
} from './mock-provider.js';

// Anthropic adapter
export { AnthropicProvider, normalizeAnthropicError } from './providers/anthropic.js';
export type {
  AnthropicCreateParams,
  AnthropicMessage,
  AnthropicMessagesClient,
  AnthropicProviderOptions,
} from './providers/anthropic.js';
export { createAnthropicClient } from './providers/anthropic-client.js';
export type { AnthropicClientOptions } from './providers/anthropic-client.js';

// OpenAI adapter
export { isOpenAiStrictCompatible, normalizeOpenAiError, OpenAiProvider } from './providers/openai.js';
export type {
  OpenAiChatCompletion,
  OpenAiChatParams,
  OpenAiClient,
  OpenAiEmbeddingResponse,
  OpenAiProviderOptions,
} from './providers/openai.js';
export { createOpenAiClient } from './providers/openai-client.js';
export type { OpenAiClientOptions } from './providers/openai-client.js';

// CLI-session adapters (ADR-0035) — headless Claude Code / Codex subprocesses
export { ClaudeCliProvider, normalizeClaudeCliError } from './providers/claude-cli.js';
export type { ClaudeCliEnvelope, ClaudeCliProviderOptions } from './providers/claude-cli.js';
export { CodexCliProvider, normalizeCodexCliError } from './providers/codex-cli.js';
export type { CodexCliEvent, CodexCliProviderOptions } from './providers/codex-cli.js';
export {
  flattenMessages,
  parseStructuredText,
  schemaInstruction,
} from './providers/cli-runner.js';
export type { CliRunner, CliRunRequest, CliRunResult } from './providers/cli-runner.js';
export { createProcessCliRunner } from './providers/cli-runner-client.js';
export type { ProcessCliRunnerOptions } from './providers/cli-runner-client.js';

// Reference catalogs
export {
  ANTHROPIC_REFERENCE_CAPABILITIES,
  CLAUDE_CLI_REFERENCE_CAPABILITIES,
  CODEX_CLI_REFERENCE_CAPABILITIES,
  OPENAI_REFERENCE_CAPABILITIES,
} from './catalogs.js';
