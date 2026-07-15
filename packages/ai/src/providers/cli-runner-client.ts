import { spawn } from 'node:child_process';
import type { CliRunner, CliRunRequest, CliRunResult } from './cli-runner.js';

/**
 * The ONLY module in the repository that imports `node:child_process`. The
 * dependency-cruiser rule `child-process-confined-to-cli-runner-client`
 * proves this (§20; ADR-0035) — the subprocess edge is confined exactly like
 * the vendor SDKs. Everything above consumes the pure `CliRunner` interface;
 * offline code and tests inject a fake runner and never spawn.
 *
 * Lifecycle ("spawn and kill", ADR-0035 §2): one short-lived process per
 * call. An abort or timeout sends SIGTERM, then SIGKILL after a short grace;
 * an abort surfaces as an `AbortError`-named rejection once the process has
 * actually exited, a timeout as a normal result with `timedOut: true`.
 */
export interface ProcessCliRunnerOptions {
  /** Grace between SIGTERM and SIGKILL when killing a process. */
  readonly killGraceMs?: number;
}

function abortError(): Error {
  const error = new Error('CLI run aborted.');
  error.name = 'AbortError';
  return error;
}

export function createProcessCliRunner(options: ProcessCliRunnerOptions = {}): CliRunner {
  const killGraceMs = options.killGraceMs ?? 2000;

  return {
    run(request: CliRunRequest, signal?: AbortSignal): Promise<CliRunResult> {
      return new Promise<CliRunResult>((resolvePromise, rejectPromise) => {
        if (signal?.aborted) {
          rejectPromise(abortError());
          return;
        }

        const child = spawn(request.command, request.args, {
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let aborted = false;
        let settled = false;
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

        const kill = (): void => {
          child.kill('SIGTERM');
          graceTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
          graceTimer.unref?.();
        };
        const onAbort = (): void => {
          aborted = true;
          kill();
        };

        const cleanup = (): void => {
          if (graceTimer !== undefined) clearTimeout(graceTimer);
          if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
          signal?.removeEventListener('abort', onAbort);
        };

        if (request.timeoutMs !== undefined) {
          timeoutTimer = setTimeout(() => {
            timedOut = true;
            kill();
          }, request.timeoutMs);
          timeoutTimer.unref?.();
        }
        signal?.addEventListener('abort', onAbort, { once: true });

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk;
        });

        child.on('error', (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          rejectPromise(error);
        });
        child.on('close', (code) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (aborted) rejectPromise(abortError());
          else resolvePromise({ exitCode: code, stdout, stderr, timedOut });
        });

        // A process that exits before reading its stdin raises EPIPE; that is
        // an outcome (captured via exit code/stderr), not a distinct failure.
        child.stdin.on('error', () => {});
        if (request.stdin !== undefined) child.stdin.write(request.stdin);
        child.stdin.end();
      });
    },
  };
}
