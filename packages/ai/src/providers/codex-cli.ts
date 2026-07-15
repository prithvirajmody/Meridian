import { AiError } from '../errors.js';
import type { AiProvider } from '../provider.js';
import {
  flattenMessages,
  parseStructuredText,
  schemaInstruction,
  type CliRunner,
  type CliRunResult,
} from './cli-runner.js';
import type {
  CompletionRequest,
  CompletionResult,
  ProviderCapabilities,
  Usage,
} from '../types.js';

/**
 * The exact slice of the `codex exec --json` JSONL event stream this adapter
 * reads (ADR-0035): the final `agent_message` item is the answer, the
 * `turn.completed` event carries token usage, and `turn.failed`/`error`
 * events are failures. This is *our* declared contract with the tool's
 * output — tests inject fakes that produce it; format drift is an
 * adapter-only change. Unrecognized event lines are ignored.
 */
export interface CodexCliEvent {
  readonly type?: string;
  readonly item?: { readonly type?: string; readonly text?: string };
  readonly usage?: {
    readonly input_tokens?: number;
    readonly cached_input_tokens?: number;
    readonly output_tokens?: number;
  };
  readonly error?: { readonly message?: string };
  readonly message?: string;
}

export interface CodexCliProviderOptions {
  readonly id?: string;
  readonly capabilities: ProviderCapabilities;
  readonly runner: CliRunner;
  /** Executable to spawn; defaults to `codex` on $PATH. */
  readonly command?: string;
  /** Per-call wall clock; on expiry the process is killed and the call fails
   * `provider_transient` (retryable under the gateway's backoff). */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Codex CLI-session provider: spawns one `codex exec` process per completion
 * and kills it on abort/timeout (ADR-0035). Auth is the CLI's own login — no
 * API key touches this repo. The sandbox is pinned read-only and the git-repo
 * check skipped (a completion needs no workspace). `codex exec` has no
 * system-prompt flag, so the request's system text is prepended to the piped
 * prompt; structured output rides an explicit schema instruction, with the
 * gateway's zod validation + one repair attempt staying authoritative.
 */
export class CodexCliProvider implements AiProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  private readonly runner: CliRunner;
  private readonly command: string;
  private readonly timeoutMs: number;

  constructor(options: CodexCliProviderOptions) {
    this.id = options.id ?? 'codex-cli';
    this.capabilities = options.capabilities;
    this.runner = options.runner;
    this.command = options.command ?? 'codex';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async complete(request: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    const parts: string[] = [];
    if (request.system !== undefined) parts.push(`System instructions:\n${request.system}`);
    parts.push(flattenMessages(request.messages));
    if (request.outputSchema !== undefined) parts.push(schemaInstruction(request.outputSchema));

    const args = [
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '-m',
      request.model,
      '-', // read the prompt from stdin
    ];

    let run: CliRunResult;
    try {
      run = await this.runner.run(
        { command: this.command, args, stdin: parts.join('\n\n'), timeoutMs: this.timeoutMs },
        signal,
      );
    } catch (error) {
      throw normalizeCodexCliError(error, this.id, request.model, this.command);
    }
    return this.normalize(run, request);
  }

  private normalize(run: CliRunResult, request: CompletionRequest): CompletionResult {
    const context = { providerId: this.id, model: request.model };
    if (run.timedOut) {
      throw new AiError(
        'provider_transient',
        `codex CLI call timed out after ${this.timeoutMs}ms; the process was killed.`,
        { ...context, raw: run },
      );
    }
    if (run.exitCode !== 0) {
      throw new AiError(
        'provider_fatal',
        `codex CLI exited with code ${run.exitCode ?? 'null (killed)'}: ${firstLine(run.stderr)}`,
        { ...context, raw: run },
      );
    }

    const events = parseEvents(run.stdout);
    let text: string | undefined;
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    for (const event of events) {
      if (event.type === 'turn.failed' || event.type === 'error') {
        throw new AiError(
          'provider_fatal',
          `codex CLI reported a failure: ${event.error?.message ?? event.message ?? 'unknown error'}.`,
          { ...context, raw: event },
        );
      }
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        text = event.item.text ?? text;
      }
      if (event.type === 'turn.completed' && event.usage !== undefined) {
        usage = {
          inputTokens: event.usage.input_tokens ?? 0,
          outputTokens: event.usage.output_tokens ?? 0,
          ...(event.usage.cached_input_tokens !== undefined
            ? { cachedInputTokens: event.usage.cached_input_tokens }
            : {}),
        };
      }
    }
    if (text === undefined) {
      throw new AiError('provider_fatal', 'codex CLI produced no agent message.', {
        ...context,
        raw: run,
      });
    }

    const base = {
      providerId: this.id,
      model: request.model,
      stopReason: 'stop' as const,
      usage,
      raw: events,
    };
    // Unparseable structured text stays undefined so the session's zod
    // validation drives the repair path, exactly like the SDK adapters.
    if (request.outputSchema !== undefined) {
      return { ...base, structured: parseStructuredText(text) };
    }
    return { ...base, text };
  }
}

function parseEvents(stdout: string): CodexCliEvent[] {
  const events: CodexCliEvent[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      events.push(JSON.parse(trimmed) as CodexCliEvent);
    } catch {
      // Non-JSON lines (banners, progress noise) are not part of the contract.
    }
  }
  return events;
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line === '' ? '(no stderr)' : line;
}

interface CodedError {
  code?: string;
  name?: string;
  message?: string;
}

/** Map a runner/spawn failure to the normalized `AiError` currency. */
export function normalizeCodexCliError(
  error: unknown,
  providerId: string,
  model: string,
  command: string,
): AiError {
  const e = (error ?? {}) as CodedError;
  const context = { providerId, model, raw: error };
  if (e.name !== undefined && /abort/i.test(e.name)) {
    return new AiError('cancelled', 'codex CLI call aborted; the process was killed.', context, {
      cause: error,
    });
  }
  if (e.code === 'ENOENT') {
    return new AiError(
      'config',
      `codex CLI not found ('${command}') — install Codex and log in, or point MERIDIAN_CODEX_CLI at the binary (no API key is needed, ADR-0035).`,
      context,
      { cause: error },
    );
  }
  return new AiError('provider_transient', 'codex CLI process failed to run.', context, {
    cause: error,
  });
}
