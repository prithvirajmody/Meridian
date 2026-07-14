/**
 * `meridian ai …` — the CLI edge of the Phase 8 AI gateway. This is the
 * composition root that wires a concrete {@link AiSession} (provider + config +
 * budget + record/replay mode) and hands it to the deterministic seams in
 * `@meridian/ai-services`; no semantic computation and no vendor SDK vocabulary
 * lives here (§8, §20).
 *
 * Trust & determinism rules honoured here:
 * - **mock** (default) and **replay** are zero-network. `mock` drives an
 *   in-process {@link MockProvider}; `replay` reads a cache-only session whose
 *   misses are a hard, deterministic `replay_miss` — a provider is never called.
 * - **live** is the only mode that can reach the network, and it does so only
 *   with explicit `--ai-consent` *and* a key from the environment (the client
 *   factories are the sole key edge). Missing either is a clean, deterministic
 *   refusal, never a silent call.
 * - AI output stays a *proposal*: these commands read a document and report the
 *   enriched/floored boundary + budget spend; they never write the graph (the
 *   one write path, ADR-0031, lives behind `applyProposal`).
 */
import {
  ANTHROPIC_REFERENCE_CAPABILITIES,
  AnthropicProvider,
  type AiConfig,
  type AiProvider,
  type AiSession,
  createAiSession,
  createAnthropicClient,
  createOpenAiClient,
  isAiError,
  MemoryResponseStore,
  MockProvider,
  type MockOutcome,
  OPENAI_REFERENCE_CAPABILITIES,
  OpenAiProvider,
  type ProviderCapabilities,
  type SessionMode,
  type TaskClass,
} from '@meridian/ai';
import {
  clusterNodes,
  type ClusterNodeInput,
  summarizeAbstraction,
} from '@meridian/ai-services';
import { containmentRollupProvider } from '@meridian/abstraction';
import { decode, encode } from '@meridian/graph-core';

// ------------------------------------------------------------------- options

/** The CLI-level AI mode (distinct from the gateway's `SessionMode`): `mock`
 * and `replay` are the two zero-network modes; `live` is gated behind consent. */
export type AiCliMode = 'mock' | 'replay' | 'live';

export interface AiCommandOptions {
  readonly json: boolean;
  /** Session dollar ceiling (`--budget`). Unset = unbounded. */
  readonly budgetDollars?: number;
  /** Provider adapter id (`--ai-provider`): `mock` | `anthropic` | `openai`. */
  readonly provider?: string;
  /** Model id (`--ai-model`); a sensible per-provider default when unset. */
  readonly model?: string;
  /** CLI AI mode (`--ai-mode`), default `mock`. */
  readonly mode?: string;
  /** Explicit consent to reach the network in `live` mode (`--ai-consent`). */
  readonly consent: boolean;
}

/** A deterministic, user-facing failure with an intended process exit code. */
class AiCliError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'AiCliError';
  }
}

function out(line: string): void {
  process.stdout.write(line + '\n');
}

function err(line: string): void {
  process.stderr.write(line + '\n');
}

// --------------------------------------------------------------- mock handlers

/** Deterministic synthetic embedding: a fixed-dimension vector derived only
 * from the input text, so the same soup always yields the same vectors (I6). */
function mockVector(text: string): number[] {
  const dim = 16;
  const v = new Array<number>(dim).fill(0);
  for (let i = 0; i < text.length; i++) {
    v[i % dim]! += (text.charCodeAt(i) % 32) / 32;
  }
  return v;
}

/** Deterministic synthetic summary derived from the rendered prompt so mock
 * output is stable and schema-valid without a network call. */
function mockSummaryOutcome(userText: string): MockOutcome {
  const domain = /Domain: (.+)/.exec(userText)?.[1]?.trim() ?? 'core';
  const firstMember = /- \(([^)]+)\) (.+)/.exec(userText)?.[2]?.trim();
  const name = (firstMember ? `Group: ${firstMember}` : 'AI group').slice(0, 80);
  const summary = `Mock AI summary of a ${domain} group.`.slice(0, 400);
  return { kind: 'json', value: { name, summary, confidence: 0.9 } };
}

// --------------------------------------------------------------- session build

const DEFAULT_MODEL: Readonly<Record<string, Partial<Record<TaskClass, string>>>> = {
  anthropic: { summarization: 'claude-opus-4-8', extraction: 'claude-opus-4-8' },
  openai: { summarization: 'gpt-4.1', extraction: 'gpt-4.1', embedding: 'text-embedding-3-large' },
};

function parseMode(raw: string | undefined): AiCliMode {
  const mode = raw ?? 'mock';
  if (mode !== 'mock' && mode !== 'replay' && mode !== 'live') {
    throw new AiCliError(2, `ai: --ai-mode must be one of mock | replay | live, got "${raw}"`);
  }
  return mode;
}

function toSessionMode(mode: AiCliMode): SessionMode {
  return mode === 'mock' ? 'off' : mode; // mock drives an in-process provider; no cache
}

function providerIdFor(mode: AiCliMode, taskClass: TaskClass, opts: AiCommandOptions): string {
  if (opts.provider !== undefined) return opts.provider;
  if (mode === 'mock') return 'mock';
  // Anthropic is completion-only in the reference catalog, so the independent
  // embedding route defaults to OpenAI while completion defaults to Anthropic.
  return taskClass === 'embedding' ? 'openai' : 'anthropic';
}

function modelFor(mode: AiCliMode, providerId: string, taskClass: TaskClass, opts: AiCommandOptions): string {
  if (opts.model !== undefined) return opts.model;
  if (mode === 'mock') return 'mock-model';
  return DEFAULT_MODEL[providerId]?.[taskClass] ?? 'claude-opus-4-8';
}

/** Capabilities for the mock provider: it both completes and embeds, so a single
 * mock backs every service, and its catalog lists the routed model. */
function mockCapabilities(model: string): ProviderCapabilities {
  return {
    completion: true,
    embedding: true,
    models: { [model]: { inputPerMTok: 1, outputPerMTok: 1 } },
  };
}

/** Build the provider instance for a mode. `mock` is in-process; `replay` uses a
 * never-invoked stand-in with the real provider's id/capabilities (routing and
 * cache keys need those, but replay reads the store and never calls it); `live`
 * builds the real adapter from the key edge. */
function buildProvider(mode: AiCliMode, providerId: string, model: string): AiProvider {
  if (mode === 'mock') {
    return new MockProvider({
      id: providerId,
      capabilities: mockCapabilities(model),
      onComplete: (request) =>
        mockSummaryOutcome(request.messages.map((m) => m.content).join('\n')),
      onEmbed: (request) => request.input.map(mockVector),
    });
  }

  if (mode === 'replay') {
    // Cache-only: the store answers or a deterministic replay_miss is thrown
    // before dispatch, so this provider is never called (zero network).
    const capabilities =
      providerId === 'openai' ? OPENAI_REFERENCE_CAPABILITIES : ANTHROPIC_REFERENCE_CAPABILITIES;
    return new MockProvider({ id: providerId, capabilities });
  }

  // live — the only mode that can reach the network.
  if (providerId === 'anthropic') {
    return new AnthropicProvider({
      id: 'anthropic',
      capabilities: ANTHROPIC_REFERENCE_CAPABILITIES,
      client: createAnthropicClient(),
    });
  }
  if (providerId === 'openai') {
    return new OpenAiProvider({
      id: 'openai',
      capabilities: OPENAI_REFERENCE_CAPABILITIES,
      client: createOpenAiClient(),
    });
  }
  throw new AiCliError(2, `ai: --ai-mode live needs --ai-provider anthropic | openai, got "${providerId}"`);
}

interface BuiltSession {
  readonly session: AiSession;
  readonly mode: AiCliMode;
  readonly providerId: string;
  readonly model: string;
}

/** Wire a session for one task class. Throws {@link AiCliError} on any
 * deterministic setup problem (bad mode, missing consent/key, bad config). */
function buildSession(taskClass: TaskClass, opts: AiCommandOptions): BuiltSession {
  const mode = parseMode(opts.mode);
  const providerId = providerIdFor(mode, taskClass, opts);
  const model = modelFor(mode, providerId, taskClass, opts);

  if (mode === 'live' && !opts.consent) {
    throw new AiCliError(
      2,
      'ai: --ai-mode live requires --ai-consent (no network call is made without explicit consent)',
    );
  }

  let provider: AiProvider;
  try {
    provider = buildProvider(mode, providerId, model);
  } catch (error) {
    if (error instanceof AiCliError) throw error;
    if (isAiError(error)) throw new AiCliError(2, `ai: ${error.message}`);
    throw error;
  }

  const config: AiConfig = {
    mode: toSessionMode(mode),
    routes: { [taskClass]: { providerId, model } },
    ...(opts.budgetDollars !== undefined
      ? { budget: { maxDollars: opts.budgetDollars } }
      : {}),
    ...(mode === 'live' ? { egressConsent: opts.consent } : {}),
  };

  try {
    const session = createAiSession({
      config,
      providers: [provider],
      // replay reads a cache; an empty one makes every miss a deterministic error.
      ...(mode === 'replay' ? { store: new MemoryResponseStore() } : {}),
    });
    return { session, mode, providerId, model };
  } catch (error) {
    if (isAiError(error)) throw new AiCliError(2, `ai: ${error.message}`);
    throw error;
  }
}

/** Map a thrown error to a printed line + exit code, deterministically. */
function reportError(error: unknown): number {
  if (error instanceof AiCliError) {
    err(error.message);
    return error.code;
  }
  if (isAiError(error)) {
    err(`ai error [${error.kind}]: ${error.message}`);
    return 1;
  }
  err(`ai error: ${(error as Error).message}`);
  return 1;
}

// ------------------------------------------------------------------ summarize

export async function cmdAiSummarize(
  file: string,
  text: string,
  opts: AiCommandOptions,
): Promise<number> {
  const decoded = decode(text);
  if (!decoded.ok) {
    out(`INVALID ${file}`);
    for (const e of decoded.errors) out(`  [${e.code}] ${e.message}`);
    return 1;
  }
  const doc = encode(decoded.space);

  let built: BuiltSession;
  try {
    built = buildSession('summarization', opts);
  } catch (error) {
    return reportError(error);
  }

  try {
    const { proposal, report } = await summarizeAbstraction(
      { session: built.session, base: containmentRollupProvider },
      doc,
      { apiVersion: '1', log: { info: () => {}, warn: () => {} } },
    );
    const groups = proposal.groups;

    if (opts.json) {
      out(
        JSON.stringify(
          {
            file,
            command: 'summarize',
            mode: built.mode,
            provider: built.providerId,
            model: built.model,
            enriched: report.enriched,
            floored: report.floored,
            stoppedByBudget: report.stoppedByBudget,
            budget: report.budget,
            groups: groups.map((g) => ({
              id: g.id,
              label: g.label,
              members: g.members.length,
              ...(g.summary !== undefined ? { summary: g.summary } : {}),
              ...(g.confidence !== undefined ? { confidence: g.confidence } : {}),
              enriched: g.providerId !== undefined,
            })),
          },
          null,
          2,
        ),
      );
      return 0;
    }

    out(`OK ${file} — summarize (mode=${built.mode}, provider=${built.providerId}, model=${built.model})`);
    out(
      `  groups ${groups.length} · enriched ${report.enriched} · floored ${report.floored}` +
        (report.stoppedByBudget ? ' · budget stopped' : ''),
    );
    out(
      `  budget: $${report.budget.spentDollars.toFixed(6)} · ` +
        `${report.budget.spentTokens} tokens · ${report.budget.calls} calls`,
    );
    for (const g of groups) {
      const tag = g.providerId !== undefined ? `ai ${(g.confidence ?? 0).toFixed(2)}` : 'floor';
      out(`  ${g.label} — ${g.members.length} member${g.members.length === 1 ? '' : 's'} [${tag}]`);
      if (g.summary !== undefined) out(`    ${g.summary}`);
    }
    return 0;
  } catch (error) {
    return reportError(error);
  }
}

// -------------------------------------------------------------------- cluster

function clusterInputsOf(space: ReturnType<typeof decode> & { ok: true }): ClusterNodeInput[] {
  const nodes: ClusterNodeInput[] = [];
  for (const graph of space.space.graphs.values()) {
    for (const node of graph.nodes.values()) {
      nodes.push({ id: node.id, text: `${node.kind} ${node.label}`, kind: node.kind, label: node.label });
    }
  }
  return nodes;
}

export async function cmdAiCluster(
  file: string,
  text: string,
  opts: AiCommandOptions,
): Promise<number> {
  const decoded = decode(text);
  if (!decoded.ok) {
    out(`INVALID ${file}`);
    for (const e of decoded.errors) out(`  [${e.code}] ${e.message}`);
    return 1;
  }
  const nodes = clusterInputsOf(decoded);

  let built: BuiltSession;
  try {
    built = buildSession('embedding', opts);
  } catch (error) {
    return reportError(error);
  }

  try {
    const result = await clusterNodes(built.session, nodes);
    const clusters = result.clusters;

    if (opts.json) {
      out(
        JSON.stringify(
          {
            file,
            command: 'cluster',
            mode: built.mode,
            provider: built.providerId,
            model: built.model,
            nodes: nodes.length,
            budget: result.budget,
            clusters: clusters.map((c) => ({
              id: c.id,
              label: c.label,
              members: c.members.length,
              confidence: c.confidence,
            })),
          },
          null,
          2,
        ),
      );
      return 0;
    }

    out(`OK ${file} — cluster (mode=${built.mode}, provider=${built.providerId}, model=${built.model})`);
    out(`  nodes ${nodes.length} · clusters ${clusters.length}`);
    out(
      `  budget: $${result.budget.spentDollars.toFixed(6)} · ` +
        `${result.budget.spentTokens} tokens · ${result.budget.calls} calls`,
    );
    for (const c of clusters) {
      out(`  ${c.label} — ${c.members.length} member${c.members.length === 1 ? '' : 's'} (confidence ${c.confidence.toFixed(2)})`);
    }
    return 0;
  } catch (error) {
    return reportError(error);
  }
}
