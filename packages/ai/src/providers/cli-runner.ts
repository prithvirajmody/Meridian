import type { JsonSchema, Message } from '../types.js';

/**
 * The vendor-neutral subprocess seam for CLI-session providers (ADR-0035).
 * A `CliRunner` plays the role the injected SDK clients play for the HTTP
 * adapters: the adapters (`claude-cli.ts`, `codex-cli.ts`) hold all argument
 * construction, envelope parsing, and error normalization against this
 * interface; only `cli-runner-client.ts` implements it with a real process
 * (the sole `node:child_process` importer, §20). Tests inject fakes, so all
 * adapter logic runs with zero subprocesses and zero network.
 */
export interface CliRunRequest {
  /** Executable to spawn — a path or a $PATH name; never a shell string. */
  readonly command: string;
  readonly args: readonly string[];
  /** Prompt text piped to the process's stdin (avoids argv length limits). */
  readonly stdin?: string;
  /** Wall-clock ceiling; on expiry the runner kills the process and returns
   * a result with `timedOut: true`. */
  readonly timeoutMs?: number;
}

/**
 * How a run ended. A non-zero exit is a *result*, not a throw — the adapter
 * decides what it means. The runner throws only for spawn failures (e.g.
 * ENOENT — binary not installed) and aborts (an `AbortError`-named error,
 * after the process has been killed).
 */
export interface CliRunResult {
  /** Process exit code; null when killed by a signal. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the run was killed by the `timeoutMs` ceiling. */
  readonly timedOut: boolean;
}

export interface CliRunner {
  run(request: CliRunRequest, signal?: AbortSignal): Promise<CliRunResult>;
}

// ------------------------------------------------------- shared pure helpers

/**
 * Flatten the gateway's message list into one prompt. Headless CLI sessions
 * take a single prompt, not a message array; a lone user message passes
 * through verbatim (the common case), while multi-message shapes (the repair
 * path appends a user message) become a role-prefixed transcript.
 */
export function flattenMessages(messages: readonly Message[]): string {
  if (messages.length === 1 && messages[0]!.role === 'user') return messages[0]!.content;
  return messages
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n');
}

/**
 * The structured-output contract for CLI sessions: no forced-tool mechanism
 * exists in a headless CLI, so the schema rides an explicit instruction and
 * the gateway's zod validation + one repair attempt stay authoritative
 * (ADR-0035 §4 — "schema in, validated value or typed failure out").
 */
export function schemaInstruction(schema: JsonSchema): string {
  return (
    'Respond with a single JSON value that conforms exactly to this JSON Schema. ' +
    'Output only the JSON — no prose, no explanation, no code fences.\n' +
    JSON.stringify(schema)
  );
}

/**
 * Parse a CLI answer as structured output, tolerating a fenced code block.
 * Unparseable text yields `undefined` (never a throw) so the session's
 * validation drives the repair path, matching the SDK adapters.
 */
export function parseStructuredText(text: string): unknown {
  let body = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/.exec(body);
  if (fenced) body = fenced[1]!.trim();
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}
