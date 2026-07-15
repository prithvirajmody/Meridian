import { describe, expect, it } from 'vitest';
import { createProcessCliRunner } from '../../src/providers/cli-runner-client.js';

/**
 * The one impure module gets a real-process test (zero network): `node -e` is
 * the spawned "CLI". Everything above this seam is tested with fake runners.
 */
const runner = createProcessCliRunner({ killGraceMs: 200 });
const node = process.execPath;

describe('createProcessCliRunner — spawn/collect lifecycle (ADR-0035)', () => {
  it('pipes stdin, captures stdout/stderr, and reports the exit code', async () => {
    const result = await runner.run({
      command: node,
      args: [
        '-e',
        'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{process.stdout.write("got:"+s);process.stderr.write("warn");process.exit(3)})',
      ],
      stdin: 'hello',
    });
    expect(result.stdout).toBe('got:hello');
    expect(result.stderr).toBe('warn');
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  it('kills a hung process at the timeout and flags timedOut', async () => {
    const result = await runner.run({
      command: node,
      args: ['-e', 'setTimeout(()=>{}, 60000)'],
      timeoutMs: 150,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(null); // killed by signal, not a clean exit
  });

  it('kills the process and rejects with AbortError when the signal fires', async () => {
    const controller = new AbortController();
    const pending = runner.run(
      { command: node, args: ['-e', 'setTimeout(()=>{}, 60000)'] },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects immediately on a pre-aborted signal without spawning', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runner.run({ command: node, args: ['-e', ''] }, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects with ENOENT for a missing binary (the adapter maps it to config)', async () => {
    await expect(
      runner.run({ command: '/nonexistent/meridian-test-binary', args: [] }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
