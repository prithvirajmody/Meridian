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
 *   with explicit `--ai-consent`. The default live provider is `claude-cli` —
 *   a locally-authenticated Claude Code session spawned per call — which needs
 *   no API key at all (ADR-0035); the SDK providers (`anthropic`, `openai`)
 *   additionally need a key from the environment (the client factories are the
 *   sole key edge). A missing consent, binary, or key is a clean,
 *   deterministic refusal, never a silent call.
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
  CLAUDE_CLI_REFERENCE_CAPABILITIES,
  ClaudeCliProvider,
  CODEX_CLI_REFERENCE_CAPABILITIES,
  CodexCliProvider,
  createAiSession,
  createAnthropicClient,
  createOpenAiClient,
  createProcessCliRunner,
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
import { readFile, writeFile } from 'node:fs/promises';
import { stderrLine, stdoutLine } from './io.js';

// ------------------------------------------------------------------- options

/** The CLI-level AI mode (distinct from the gateway's `SessionMode`): `mock`
 * and `replay` are the two zero-network modes; `record` captures a fixture set
 * (zero-network with the default mock provider, consent-gated otherwise);
 * `live` is gated behind consent. */
export type AiCliMode = 'mock' | 'replay' | 'record' | 'live';

export interface AiCommandOptions {
  readonly json: boolean;
  /** Session dollar ceiling (`--budget`). Unset = unbounded. */
  readonly budgetDollars?: number;
  /** Provider adapter id (`--ai-provider`): `mock` | `claude-cli` |
   * `codex-cli` | `anthropic` | `openai`. */
  readonly provider?: string;
  /** Model id (`--ai-model`); a sensible per-provider default when unset. */
  readonly model?: string;
  /** CLI AI mode (`--ai-mode`), default `mock`. */
  readonly mode?: string;
  /** Explicit consent to reach the network in `live` mode (`--ai-consent`). */
  readonly consent: boolean;
  /** Response-fixture file (`--ai-fixtures`): read in `replay`, written in
   * `record` (ADR-0030 — the durable record/replay store). */
  readonly fixtures?: string;
}

/** A deterministic, user-facing failure with an intended process exit code. */
export class AiCliError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'AiCliError';
  }
}

function out(line: string): void {
  stdoutLine(line);
}

function err(line: string): void {
  stderrLine(line);
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

/** Deterministic synthetic extraction: up to two claim-worthy sentences of the
 * source text become typed nodes; a pair gets one typed edge. For the `arg`
 * domain the pair is claim ← premise with an `arg:supports` edge (the 9D
 * vocabulary); everywhere else two claims with a refers-back edge (9C).
 * Stable and schema-valid (`extractedStructureSchema`) with no network. */
function mockExtractOutcome(system: string, userText: string): MockOutcome {
  const domain = /"([a-z][a-z0-9-]*):name"/.exec(system)?.[1] ?? 'core';
  const sentences = userText
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 24);
  const kinds = domain === 'arg' ? ['claim', 'premise'] : ['claim', 'claim'];
  const nodes = sentences.slice(0, 2).map((s, i) => ({
    id: `${domain}:c-${i + 1}`,
    kind: `${domain}:${kinds[i]!}`,
    label: s.length > 120 ? `${s.slice(0, 119)}…` : s,
  }));
  const edgeKind = domain === 'arg' ? 'supports' : 'refers-back';
  const edges =
    nodes.length === 2
      ? [{ id: `${domain}:r-1`, src: `${domain}:c-2`, dst: `${domain}:c-1`, kind: `${domain}:${edgeKind}` }]
      : [];
  return { kind: 'json', value: { nodes, edges } };
}

/** Route a mock completion by prompt: the extract-structure prompt gets the
 * synthetic extraction, everything else the synthetic summary. */
function mockCompletionOutcome(system: string, userText: string): MockOutcome {
  if (system.startsWith('You extract a small typed graph')) return mockExtractOutcome(system, userText);
  return mockSummaryOutcome(userText);
}

// --------------------------------------------------------------- session build

const DEFAULT_MODEL: Readonly<Record<string, Partial<Record<TaskClass, string>>>> = {
  'claude-cli': { summarization: 'claude-opus-4-8', extraction: 'claude-opus-4-8' },
  'codex-cli': { summarization: 'gpt-5-codex', extraction: 'gpt-5-codex' },
  anthropic: { summarization: 'claude-opus-4-8', extraction: 'claude-opus-4-8' },
  openai: { summarization: 'gpt-4.1', extraction: 'gpt-4.1', embedding: 'text-embedding-3-large' },
};

function parseMode(raw: string | undefined): AiCliMode {
  const mode = raw ?? 'mock';
  if (mode !== 'mock' && mode !== 'replay' && mode !== 'record' && mode !== 'live') {
    throw new AiCliError(2, `ai: --ai-mode must be one of mock | replay | record | live, got "${raw}"`);
  }
  return mode;
}

function toSessionMode(mode: AiCliMode): SessionMode {
  return mode === 'mock' ? 'off' : mode; // mock drives an in-process provider; no cache
}

function providerIdFor(mode: AiCliMode, taskClass: TaskClass, opts: AiCommandOptions): string {
  if (opts.provider !== undefined) return opts.provider;
  // `mock` is in-process; `record` also defaults to the mock provider so the
  // default record path stays zero-network (recording live needs an explicit
  // --ai-provider plus consent, same as live mode).
  if (mode === 'mock' || mode === 'record') return 'mock';
  // Completion defaults to the keyless Claude Code session provider
  // (ADR-0035); the CLIs do not embed, so the independent embedding route
  // still defaults to the embedding-capable SDK provider (OpenAI).
  return taskClass === 'embedding' ? 'openai' : 'claude-cli';
}

function modelFor(mode: AiCliMode, providerId: string, taskClass: TaskClass, opts: AiCommandOptions): string {
  if (opts.model !== undefined) return opts.model;
  if (providerId === 'mock') return 'mock-model';
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

/** Build the provider instance for a mode. `mock` (and mock-backed `record`) is
 * in-process; `replay` uses a never-invoked stand-in with the real provider's
 * id/capabilities (routing and cache keys need those, but replay reads the
 * store and never calls it); `live` (and live `record`) builds the real
 * adapter from the key edge. */
function buildProvider(mode: AiCliMode, providerId: string, model: string): AiProvider {
  if (providerId === 'mock' && mode !== 'replay') {
    return new MockProvider({
      id: providerId,
      capabilities: mockCapabilities(model),
      onComplete: (request) =>
        mockCompletionOutcome(request.system ?? '', request.messages.map((m) => m.content).join('\n')),
      onEmbed: (request) => request.input.map(mockVector),
    });
  }

  if (mode === 'replay') {
    // Cache-only: the store answers or a deterministic replay_miss is thrown
    // before dispatch, so this provider is never called (zero network).
    const capabilities =
      providerId === 'openai'
        ? OPENAI_REFERENCE_CAPABILITIES
        : providerId === 'claude-cli'
          ? CLAUDE_CLI_REFERENCE_CAPABILITIES
          : providerId === 'codex-cli'
            ? CODEX_CLI_REFERENCE_CAPABILITIES
            : providerId === 'mock'
              ? mockCapabilities(model)
              : ANTHROPIC_REFERENCE_CAPABILITIES;
    return new MockProvider({ id: providerId, capabilities });
  }

  // live (or live record) — the only paths that can reach the network. The
  // CLI-session providers spawn a locally-authenticated agent per call and
  // kill it on completion/abort — no API key (ADR-0035); MERIDIAN_CLAUDE_CLI /
  // MERIDIAN_CODEX_CLI override the binary, the env/config edge (§8.2).
  if (providerId === 'claude-cli') {
    return new ClaudeCliProvider({
      id: 'claude-cli',
      capabilities: CLAUDE_CLI_REFERENCE_CAPABILITIES,
      runner: createProcessCliRunner(),
      ...(process.env['MERIDIAN_CLAUDE_CLI'] !== undefined
        ? { command: process.env['MERIDIAN_CLAUDE_CLI'] }
        : {}),
    });
  }
  if (providerId === 'codex-cli') {
    return new CodexCliProvider({
      id: 'codex-cli',
      capabilities: CODEX_CLI_REFERENCE_CAPABILITIES,
      runner: createProcessCliRunner(),
      ...(process.env['MERIDIAN_CODEX_CLI'] !== undefined
        ? { command: process.env['MERIDIAN_CODEX_CLI'] }
        : {}),
    });
  }
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
  throw new AiCliError(2, `ai: --ai-mode ${mode} needs --ai-provider mock | claude-cli | codex-cli | anthropic | openai, got "${providerId}"`);
}

export interface BuiltSession {
  readonly session: AiSession;
  readonly mode: AiCliMode;
  readonly providerId: string;
  readonly model: string;
  /** The fixture store (present in `replay`/`record`; `record` persists it). */
  readonly store?: MemoryResponseStore;
}

/** Load a `--ai-fixtures` file into a fresh response store. A missing/corrupt
 * file is a deterministic setup error, never a silent empty cache. */
async function loadFixtureStore(path: string): Promise<MemoryResponseStore> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    throw new AiCliError(2, `ai: cannot read --ai-fixtures ${path}: ${(e as Error).message}`);
  }
  try {
    const store = new MemoryResponseStore();
    store.load(JSON.parse(text) as Parameters<MemoryResponseStore['load']>[0]);
    return store;
  } catch (e) {
    throw new AiCliError(2, `ai: --ai-fixtures ${path} is not a fixture snapshot: ${(e as Error).message}`);
  }
}

/** Persist a `record` session's captured responses to the `--ai-fixtures` file
 * (stable key order, so a re-record with identical calls is byte-identical). */
export async function persistFixtures(built: BuiltSession, path: string): Promise<void> {
  const snapshot = built.store?.snapshot() ?? {};
  const sorted = Object.fromEntries(Object.entries(snapshot).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  await writeFile(path, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
}

/** Wire one session covering `taskClasses`. Throws {@link AiCliError} on any
 * deterministic setup problem (bad mode, missing consent/key, bad config).
 * The reported `providerId`/`model` are the first task class's route. */
export async function buildSessionFor(
  taskClasses: readonly TaskClass[],
  opts: AiCommandOptions,
): Promise<BuiltSession> {
  const mode = parseMode(opts.mode);

  const canEgress = mode === 'live' || (mode === 'record' && providerIdFor(mode, taskClasses[0]!, opts) !== 'mock');
  if (canEgress && !opts.consent) {
    throw new AiCliError(
      2,
      `ai: --ai-mode ${mode} with a real provider requires --ai-consent (no network call is made without explicit consent)`,
    );
  }

  const routes: Record<string, { providerId: string; model: string }> = {};
  const providers = new Map<string, AiProvider>();
  try {
    for (const taskClass of taskClasses) {
      const providerId = providerIdFor(mode, taskClass, opts);
      const model = modelFor(mode, providerId, taskClass, opts);
      routes[taskClass] = { providerId, model };
      if (!providers.has(providerId)) providers.set(providerId, buildProvider(mode, providerId, model));
    }
  } catch (error) {
    if (error instanceof AiCliError) throw error;
    if (isAiError(error)) throw new AiCliError(2, `ai: ${error.message}`);
    throw error;
  }

  let store: MemoryResponseStore | undefined;
  if (mode === 'replay') {
    // Replay reads a cache; without fixtures an empty one makes every miss a
    // deterministic error (never a network fallback — ADR-0030).
    store = opts.fixtures !== undefined ? await loadFixtureStore(opts.fixtures) : new MemoryResponseStore();
  } else if (mode === 'record') {
    store = new MemoryResponseStore();
  }

  const config: AiConfig = {
    mode: toSessionMode(mode),
    routes,
    ...(opts.budgetDollars !== undefined
      ? { budget: { maxDollars: opts.budgetDollars } }
      : {}),
    // The gateway demands egressConsent for any mode that *could* dispatch to a
    // provider (live/record). The CLI consent boundary is `canEgress` above: a
    // real provider needs --ai-consent; a mock-backed record is in-process and
    // cannot egress, so satisfying the gateway's flag grants nothing.
    ...(mode === 'live' || mode === 'record' ? { egressConsent: canEgress ? opts.consent : true } : {}),
  };

  const primary = routes[taskClasses[0]!]!;
  try {
    const session = createAiSession({
      config,
      providers: [...providers.values()],
      ...(store !== undefined ? { store } : {}),
    });
    return {
      session,
      mode,
      providerId: primary.providerId,
      model: primary.model,
      ...(store !== undefined ? { store } : {}),
    };
  } catch (error) {
    if (isAiError(error)) throw new AiCliError(2, `ai: ${error.message}`);
    throw error;
  }
}

/** Wire a session for one task class (the 8F commands' shape). */
function buildSession(taskClass: TaskClass, opts: AiCommandOptions): Promise<BuiltSession> {
  return buildSessionFor([taskClass], opts);
}

/** Map a thrown error to a printed line + exit code, deterministically. */
export function reportError(error: unknown): number {
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
    built = await buildSession('summarization', opts);
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
    built = await buildSession('embedding', opts);
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
