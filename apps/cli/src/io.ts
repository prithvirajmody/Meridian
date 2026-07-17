/** Synchronous CLI output: immediate process exit must never truncate a pipe. */
import { writeSync } from 'node:fs';

export function writeStdout(text: string): void {
  writeSync(1, text);
}

export function writeStderr(text: string): void {
  writeSync(2, text);
}

export function stdoutLine(line: string): void {
  writeStdout(line + '\n');
}

export function stderrLine(line: string): void {
  writeStderr(line + '\n');
}
