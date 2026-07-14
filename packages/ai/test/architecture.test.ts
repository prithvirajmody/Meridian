import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));
const SDK_IMPORT = /(?:from|import)\s*\(?\s*['"](@anthropic-ai\/sdk|openai)['"]/;

// The two — and only two — modules permitted to import a vendor AI SDK.
const ALLOWED = new Set(['providers/anthropic-client.ts', 'providers/openai-client.ts']);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('architecture: vendor SDK imports are confined to the adapter client factories (§20)', () => {
  const files = walk(SRC_DIR);

  it('finds the src tree', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('no module outside the two client factories imports @anthropic-ai/sdk or openai', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(SRC_DIR, file).split('\\').join('/');
      if (ALLOWED.has(rel)) continue;
      if (SDK_IMPORT.test(readFileSync(file, 'utf8'))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('each client factory does import its SDK (the confinement is real, not vacuous)', () => {
    for (const rel of ALLOWED) {
      const content = readFileSync(join(SRC_DIR, rel), 'utf8');
      expect(SDK_IMPORT.test(content)).toBe(true);
    }
  });
});
