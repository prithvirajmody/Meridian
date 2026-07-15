import { describe, expect, it } from 'vitest';
import {
  CodexCliProvider,
  normalizeCodexCliError,
} from '../../src/providers/codex-cli.js';
import type { CliRunner, CliRunRequest, CliRunResult } from '../../src/providers/cli-runner.js';
import type { CompletionRequest, ProviderCapabilities } from '../../src/types.js';

const CAPS: ProviderCapabilities = {
  completion: true,
  embedding: false,
  models: { 'gpt-x': { inputPerMTok: 1.25, outputPerMTok: 10 } },
};

interface Fake {
  runner: CliRunner;
  state: { request?: CliRunRequest; signal?: AbortSignal };
}

function fakeReturning(result: CliRunResult): Fake {
  const state: Fake['state'] = {};
  return {
    state,
    runner: {
      run: (request, signal) => {
        state.request = request;
        if (signal !== undefined) state.signal = signal;
        return Promise.resolve(result);
      },
    },
  };
}

function jsonl(events: unknown[]): CliRunResult {
  return {
    exitCode: 0,
    stdout: events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    stderr: '',
    timedOut: false,
  };
}

const HAPPY_EVENTS = [
  { type: 'session.created', session_id: 's-1' },
  { type: 'item.completed', item: { type: 'reasoning', text: 'thinking…' } },
  { type: 'item.completed', item: { type: 'agent_message', text: '{"name":"N","summary":"S","confidence":0.8}' } },
  { type: 'turn.completed', usage: { input_tokens: 9, cached_input_tokens: 4, output_tokens: 5 } },
];

const structuredRequest: CompletionRequest = {
  model: 'gpt-x',
  system: 'sys',
  messages: [{ role: 'user', content: 'hi' }],
  maxOutputTokens: 100,
  outputSchema: { type: 'object' },
};

describe('CodexCliProvider.complete — spawn shape', () => {
  it('spawns one read-only exec call with the routed model and piped prompt', async () => {
    const fake = fakeReturning(jsonl(HAPPY_EVENTS));
    const provider = new CodexCliProvider({ capabilities: CAPS, runner: fake.runner });
    const controller = new AbortController();
    await provider.complete(structuredRequest, controller.signal);

    expect(fake.state.request?.command).toBe('codex');
    const args = fake.state.request?.args ?? [];
    expect(args[0]).toBe('exec');
    expect(args).toContain('--json');
    expect(args.join(' ')).toContain('--sandbox read-only');
    expect(args).toContain('--skip-git-repo-check');
    expect(args.join(' ')).toContain('-m gpt-x');
    expect(args[args.length - 1]).toBe('-');
    expect(fake.state.signal).toBe(controller.signal);
  });

  it('prepends system text and appends the schema instruction to the piped prompt', async () => {
    const fake = fakeReturning(jsonl(HAPPY_EVENTS));
    const provider = new CodexCliProvider({ capabilities: CAPS, runner: fake.runner });
    await provider.complete(structuredRequest);

    const stdin = fake.state.request?.stdin ?? '';
    expect(stdin).toContain('System instructions:\nsys');
    expect(stdin).toContain('hi');
    expect(stdin).toContain('JSON Schema');
    expect(stdin.indexOf('sys')).toBeLessThan(stdin.indexOf('hi'));
    expect(stdin.indexOf('hi')).toBeLessThan(stdin.indexOf('JSON Schema'));
  });

  it('honours the command and timeout options', async () => {
    const fake = fakeReturning(jsonl(HAPPY_EVENTS));
    const provider = new CodexCliProvider({
      capabilities: CAPS,
      runner: fake.runner,
      command: '/opt/codex',
      timeoutMs: 4321,
    });
    await provider.complete(structuredRequest);
    expect(fake.state.request?.command).toBe('/opt/codex');
    expect(fake.state.request?.timeoutMs).toBe(4321);
  });
});

describe('CodexCliProvider.complete — event-stream normalization', () => {
  it('takes the final agent message as the answer and turn.completed as usage', async () => {
    const provider = new CodexCliProvider({ capabilities: CAPS, runner: fakeReturning(jsonl(HAPPY_EVENTS)).runner });
    const result = await provider.complete(structuredRequest);

    expect(result.structured).toEqual({ name: 'N', summary: 'S', confidence: 0.8 });
    expect(result.stopReason).toBe('stop');
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 5, cachedInputTokens: 4 });
    expect(result.providerId).toBe('codex-cli');
    expect(result.model).toBe('gpt-x');
  });

  it('the last agent message wins and non-JSON noise lines are ignored', async () => {
    const run = jsonl(HAPPY_EVENTS);
    const noisy: CliRunResult = {
      ...run,
      stdout:
        'codex banner line\n' +
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'draft' } }) +
        '\n' +
        run.stdout,
    };
    const provider = new CodexCliProvider({ capabilities: CAPS, runner: fakeReturning(noisy).runner });
    const result = await provider.complete({ ...structuredRequest, outputSchema: undefined });
    expect(result.text).toBe('{"name":"N","summary":"S","confidence":0.8}');
  });

  it('maps turn.failed to provider_fatal with the reported message', async () => {
    const failed = jsonl([{ type: 'turn.failed', error: { message: 'usage limit reached' } }]);
    const provider = new CodexCliProvider({ capabilities: CAPS, runner: fakeReturning(failed).runner });
    await expect(provider.complete(structuredRequest)).rejects.toMatchObject({
      kind: 'provider_fatal',
      message: expect.stringContaining('usage limit reached') as string,
    });
  });

  it('maps a stream with no agent message to provider_fatal', async () => {
    const empty = jsonl([{ type: 'session.created' }]);
    const provider = new CodexCliProvider({ capabilities: CAPS, runner: fakeReturning(empty).runner });
    await expect(provider.complete(structuredRequest)).rejects.toMatchObject({ kind: 'provider_fatal' });
  });

  it('maps a non-zero exit to provider_fatal and a timeout kill to provider_transient', async () => {
    const failed: CliRunResult = { exitCode: 2, stdout: '', stderr: 'not logged in', timedOut: false };
    const timedOut: CliRunResult = { exitCode: null, stdout: '', stderr: '', timedOut: true };
    const p1 = new CodexCliProvider({ capabilities: CAPS, runner: fakeReturning(failed).runner });
    const p2 = new CodexCliProvider({ capabilities: CAPS, runner: fakeReturning(timedOut).runner });
    await expect(p1.complete(structuredRequest)).rejects.toMatchObject({
      kind: 'provider_fatal',
      message: expect.stringContaining('not logged in') as string,
    });
    await expect(p2.complete(structuredRequest)).rejects.toMatchObject({ kind: 'provider_transient' });
  });
});

describe('normalizeCodexCliError', () => {
  it('maps aborts, missing binaries, and other spawn faults to the normalized kinds', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(normalizeCodexCliError(abort, 'codex-cli', 'gpt-x', 'codex').kind).toBe('cancelled');
    expect(normalizeCodexCliError({ code: 'ENOENT' }, 'codex-cli', 'gpt-x', 'codex').kind).toBe('config');
    expect(normalizeCodexCliError(new Error('EPERM'), 'codex-cli', 'gpt-x', 'codex').kind).toBe(
      'provider_transient',
    );
  });
});
