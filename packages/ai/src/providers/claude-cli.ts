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
 * The exact slice of the `claude -p --output-format json` result envelope this
 * adapter reads (ADR-0035). Like `AnthropicMessage` for the SDK adapter, this
 * is *our* declared contract with the tool's output — tests inject fakes that
 * produce it, and a CLI format drift is an adapter-only change.
 */
export interface ClaudeCliEnvelope {
  readonly type?: string;
  /** 'success' | 'error_max_turns' | 'error_during_execution' | … */
  readonly subtype?: string;
  readonly is_error?: boolean;
  /** The assistant's final text answer. */
  readonly result?: string;
  readonly session_id?: string;
  /** Real subscription-side cost as the CLI reports it; retained in `raw`
   * only — budget meters notional catalog prices (ADR-0035 §6). */
  readonly total_cost_usd?: number;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly cache_read_input_tokens?: number;
  };
}

export interface ClaudeCliProviderOptions {
  readonly id?: string;
  readonly capabilities: ProviderCapabilities;
  readonly runner: CliRunner;
  /** Executable to spawn; defaults to `claude` on $PATH. */
  readonly command?: string;
  /** Per-call wall clock; on expiry the process is killed and the call fails
   * `provider_transient` (retryable under the gateway's backoff). */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Claude Code CLI-session provider: spawns one headless `claude -p` process
 * per completion and kills it on abort/timeout (ADR-0035). No API key touches
 * this repo — auth is the CLI's own login. Structured output rides an explicit
 * schema instruction (no forced-tool mechanism headlessly); the gateway's zod
 * validation + one repair attempt stay authoritative. `--max-turns 1` and
 * `--strict-mcp-config` pin the session to a single tool-less completion. The
 * CLI exposes no `max_tokens`/`temperature`/`stop_sequences` knobs, so those
 * request fields are not forwarded — schema validation is the output contract.
 */
export class ClaudeCliProvider implements AiProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  private readonly runner: CliRunner;
  private readonly command: string;
  private readonly timeoutMs: number;

  constructor(options: ClaudeCliProviderOptions) {
    this.id = options.id ?? 'claude-cli';
    this.capabilities = options.capabilities;
    this.runner = options.runner;
    this.command = options.command ?? 'claude';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async complete(request: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    const systemParts: string[] = [];
    if (request.system !== undefined) systemParts.push(request.system);
    if (request.outputSchema !== undefined) systemParts.push(schemaInstruction(request.outputSchema));

    const args: string[] = [
      '-p',
      '--output-format',
      'json',
      '--model',
      request.model,
      '--max-turns',
      '1',
      '--strict-mcp-config',
    ];
    if (systemParts.length > 0) args.push('--system-prompt', systemParts.join('\n\n'));

    let run: CliRunResult;
    try {
      run = await this.runner.run(
        {
          command: this.command,
          args,
          stdin: flattenMessages(request.messages),
          timeoutMs: this.timeoutMs,
        },
        signal,
      );
    } catch (error) {
      throw normalizeClaudeCliError(error, this.id, request.model, this.command);
    }
    return this.normalize(run, request);
  }

  private normalize(run: CliRunResult, request: CompletionRequest): CompletionResult {
    const context = { providerId: this.id, model: request.model };
    if (run.timedOut) {
      throw new AiError(
        'provider_transient',
        `claude CLI call timed out after ${this.timeoutMs}ms; the process was killed.`,
        { ...context, raw: run },
      );
    }
    if (run.exitCode !== 0) {
      throw new AiError(
        'provider_fatal',
        `claude CLI exited with code ${run.exitCode ?? 'null (killed)'}: ${firstLine(run.stderr)}`,
        { ...context, raw: run },
      );
    }

    let envelope: ClaudeCliEnvelope;
    try {
      envelope = JSON.parse(run.stdout) as ClaudeCliEnvelope;
    } catch {
      throw new AiError('provider_fatal', 'claude CLI did not print a JSON result envelope.', {
        ...context,
        raw: run,
      });
    }
    if (envelope.is_error === true || (envelope.subtype !== undefined && envelope.subtype !== 'success')) {
      throw new AiError(
        'provider_fatal',
        `claude CLI reported an error result (subtype '${envelope.subtype ?? 'unknown'}').`,
        { ...context, raw: envelope },
      );
    }

    const usage: Usage = {
      inputTokens: envelope.usage?.input_tokens ?? 0,
      outputTokens: envelope.usage?.output_tokens ?? 0,
      ...(envelope.usage?.cache_read_input_tokens !== undefined
        ? { cachedInputTokens: envelope.usage.cache_read_input_tokens }
        : {}),
    };
    const text = envelope.result ?? '';
    const base = {
      providerId: this.id,
      model: request.model,
      stopReason: 'stop' as const,
      usage,
      raw: envelope,
    };
    // Unparseable structured text stays undefined so the session's zod
    // validation drives the repair path, exactly like the SDK adapters.
    if (request.outputSchema !== undefined) {
      return { ...base, structured: parseStructuredText(text) };
    }
    return { ...base, text };
  }
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
export function normalizeClaudeCliError(
  error: unknown,
  providerId: string,
  model: string,
  command: string,
): AiError {
  const e = (error ?? {}) as CodedError;
  const context = { providerId, model, raw: error };
  if (e.name !== undefined && /abort/i.test(e.name)) {
    return new AiError('cancelled', 'claude CLI call aborted; the process was killed.', context, {
      cause: error,
    });
  }
  if (e.code === 'ENOENT') {
    return new AiError(
      'config',
      `claude CLI not found ('${command}') — install Claude Code and log in, or point MERIDIAN_CLAUDE_CLI at the binary (no API key is needed, ADR-0035).`,
      context,
      { cause: error },
    );
  }
  return new AiError('provider_transient', 'claude CLI process failed to run.', context, {
    cause: error,
  });
}
