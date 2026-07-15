import { describe, expect, it } from 'vitest';
import {
  ClaudeCliProvider,
  normalizeClaudeCliError,
  type ClaudeCliEnvelope,
} from '../../src/providers/claude-cli.js';
import type { CliRunner, CliRunRequest, CliRunResult } from '../../src/providers/cli-runner.js';
import type { CompletionRequest, ProviderCapabilities } from '../../src/types.js';

const CAPS: ProviderCapabilities = {
  completion: true,
  embedding: false,
  models: { 'claude-x': { inputPerMTok: 15, outputPerMTok: 75 } },
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

function fakeThrowing(error: unknown): CliRunner {
  return { run: () => Promise.reject(error) };
}

function envelope(overrides: Partial<ClaudeCliEnvelope> = {}): CliRunResult {
  const body: ClaudeCliEnvelope = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '{"name":"N","summary":"S","confidence":0.9}',
    session_id: 's-1',
    total_cost_usd: 0.01,
    usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3 },
    ...overrides,
  };
  return { exitCode: 0, stdout: JSON.stringify(body), stderr: '', timedOut: false };
}

const structuredRequest: CompletionRequest = {
  model: 'claude-x',
  system: 'sys',
  messages: [{ role: 'user', content: 'hi' }],
  maxOutputTokens: 100,
  outputSchema: { type: 'object' },
};

describe('ClaudeCliProvider.complete — spawn shape', () => {
  it('spawns one headless print-mode call with the routed model and piped prompt', async () => {
    const fake = fakeReturning(envelope());
    const provider = new ClaudeCliProvider({ capabilities: CAPS, runner: fake.runner });
    const controller = new AbortController();
    await provider.complete(structuredRequest, controller.signal);

    expect(fake.state.request?.command).toBe('claude');
    const args = fake.state.request?.args ?? [];
    expect(args).toContain('-p');
    expect(args.join(' ')).toContain('--output-format json');
    expect(args.join(' ')).toContain('--model claude-x');
    expect(args.join(' ')).toContain('--max-turns 1');
    expect(args).toContain('--strict-mcp-config');
    expect(fake.state.request?.stdin).toBe('hi');
    expect(fake.state.request?.timeoutMs).toBeGreaterThan(0);
    expect(fake.state.signal).toBe(controller.signal);
  });

  it('carries the system prompt and the schema instruction via --system-prompt', async () => {
    const fake = fakeReturning(envelope());
    const provider = new ClaudeCliProvider({ capabilities: CAPS, runner: fake.runner });
    await provider.complete(structuredRequest);

    const args = fake.state.request?.args ?? [];
    const systemPrompt = args[args.indexOf('--system-prompt') + 1] ?? '';
    expect(systemPrompt).toContain('sys');
    expect(systemPrompt).toContain('JSON Schema');
    expect(systemPrompt).toContain('{"type":"object"}');
  });

  it('omits the schema instruction for plain-text requests', async () => {
    const fake = fakeReturning(envelope({ result: 'plain answer' }));
    const provider = new ClaudeCliProvider({ capabilities: CAPS, runner: fake.runner });
    const result = await provider.complete({
      model: 'claude-x',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 100,
    });

    const args = fake.state.request?.args ?? [];
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('sys');
    expect(result.text).toBe('plain answer');
    expect(result.structured).toBeUndefined();
  });

  it('flattens a multi-message request (the repair shape) into a transcript', async () => {
    const fake = fakeReturning(envelope());
    const provider = new ClaudeCliProvider({ capabilities: CAPS, runner: fake.runner });
    await provider.complete({
      ...structuredRequest,
      messages: [
        { role: 'user', content: 'go' },
        { role: 'user', content: 'fix it' },
      ],
    });
    expect(fake.state.request?.stdin).toBe('User: go\n\nUser: fix it');
  });

  it('honours the command and timeout options', async () => {
    const fake = fakeReturning(envelope());
    const provider = new ClaudeCliProvider({
      capabilities: CAPS,
      runner: fake.runner,
      command: '/opt/claude',
      timeoutMs: 1234,
    });
    await provider.complete(structuredRequest);
    expect(fake.state.request?.command).toBe('/opt/claude');
    expect(fake.state.request?.timeoutMs).toBe(1234);
  });
});

describe('ClaudeCliProvider.complete — envelope normalization', () => {
  it('parses the result JSON as structured output and normalizes usage', async () => {
    const provider = new ClaudeCliProvider({ capabilities: CAPS, runner: fakeReturning(envelope()).runner });
    const result = await provider.complete(structuredRequest);

    expect(result.structured).toEqual({ name: 'N', summary: 'S', confidence: 0.9 });
    expect(result.stopReason).toBe('stop');
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 7, cachedInputTokens: 3 });
    expect(result.providerId).toBe('claude-cli');
    expect(result.model).toBe('claude-x');
    expect((result.raw as ClaudeCliEnvelope).total_cost_usd).toBe(0.01);
  });

  it('strips a fenced code block before parsing structured output', async () => {
    const fenced = envelope({ result: '```json\n{"name":"N","summary":"S","confidence":1}\n```' });
    const provider = new ClaudeCliProvider({ capabilities: CAPS, runner: fakeReturning(fenced).runner });
    const result = await provider.complete(structuredRequest);
    expect(result.structured).toEqual({ name: 'N', summary: 'S', confidence: 1 });
  });

  it('leaves structured undefined for malformed JSON so the gateway can repair', async () => {
    const bad = envelope({ result: 'sorry, here is prose' });
    const provider = new ClaudeCliProvider({ capabilities: CAPS, runner: fakeReturning(bad).runner });
    const result = await provider.complete(structuredRequest);
    expect(result.structured).toBeUndefined();
  });

  it('maps an error envelope to provider_fatal', async () => {
    const err = envelope({ is_error: true, subtype: 'error_during_execution' });
    const provider = new ClaudeCliProvider({ capabilities: CAPS, runner: fakeReturning(err).runner });
    await expect(provider.complete(structuredRequest)).rejects.toMatchObject({ kind: 'provider_fatal' });
  });

  it('maps a non-JSON stdout to provider_fatal', async () => {
    const garbage: CliRunResult = { exitCode: 0, stdout: 'not json', stderr: '', timedOut: false };
    const provider = new ClaudeCliProvider({ capabilities: CAPS, runner: fakeReturning(garbage).runner });
    await expect(provider.complete(structuredRequest)).rejects.toMatchObject({ kind: 'provider_fatal' });
  });

  it('maps a non-zero exit to provider_fatal with the stderr head', async () => {
    const failed: CliRunResult = { exitCode: 1, stdout: '', stderr: 'boom\nmore', timedOut: false };
    const provider = new ClaudeCliProvider({ capabilities: CAPS, runner: fakeReturning(failed).runner });
    await expect(provider.complete(structuredRequest)).rejects.toMatchObject({
      kind: 'provider_fatal',
      message: expect.stringContaining('boom') as string,
    });
  });

  it('maps a killed-by-timeout run to provider_transient (retryable)', async () => {
    const timedOut: CliRunResult = { exitCode: null, stdout: '', stderr: '', timedOut: true };
    const provider = new ClaudeCliProvider({ capabilities: CAPS, runner: fakeReturning(timedOut).runner });
    await expect(provider.complete(structuredRequest)).rejects.toMatchObject({ kind: 'provider_transient' });
  });
});

describe('normalizeClaudeCliError', () => {
  it('maps aborts, missing binaries, and other spawn faults to the normalized kinds', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(normalizeClaudeCliError(abort, 'claude-cli', 'claude-x', 'claude').kind).toBe('cancelled');
    expect(
      normalizeClaudeCliError({ code: 'ENOENT' }, 'claude-cli', 'claude-x', 'claude').kind,
    ).toBe('config');
    expect(normalizeClaudeCliError(new Error('EPERM'), 'claude-cli', 'claude-x', 'claude').kind).toBe(
      'provider_transient',
    );
  });

  it('propagates through complete()', async () => {
    const enoent = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    const provider = new ClaudeCliProvider({ capabilities: CAPS, runner: fakeThrowing(enoent) });
    await expect(provider.complete(structuredRequest)).rejects.toMatchObject({
      kind: 'config',
      message: expect.stringContaining('claude CLI not found') as string,
    });
  });
});
