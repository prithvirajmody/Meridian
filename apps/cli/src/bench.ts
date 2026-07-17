/** Composition-root bridge for `meridian bench`. The benchmark suite remains
 * repository-owned JavaScript so CI and the CLI execute the exact same files. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stderrLine } from './io.js';

export function resolveBenchRunner(moduleUrl: string = import.meta.url): string {
  return fileURLToPath(new URL('../../../benchmarks/run.mjs', moduleUrl));
}

export async function cmdBench(json: boolean): Promise<number> {
  const child = spawn(process.execPath, [resolveBenchRunner(), ...(json ? ['--json'] : [])], {
    stdio: 'inherit',
    env: process.env,
  });
  return await new Promise<number>((resolve) => {
    child.once('error', (error) => {
      stderrLine(`cannot start benchmark suite: ${error.message}`);
      resolve(2);
    });
    child.once('exit', (code, signal) => {
      if (signal !== null) {
        stderrLine(`benchmark suite terminated by ${signal}`);
        resolve(1);
      } else {
        resolve(code ?? 1);
      }
    });
  });
}
