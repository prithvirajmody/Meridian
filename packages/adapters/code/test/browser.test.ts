/**
 * 7B smoke, browser leg: the same shim loads both vendored grammars in a real
 * (headless) browser — wasm fetched over HTTP, runtime wasm via `locateFile`,
 * grammar-load failure still a located error (SUBPHASES §7B: "shim loads both
 * grammars in Node and (headless) browser").
 *
 * Uses `playwright-core` (no browser download) against a locally available
 * Chromium: `$MERIDIAN_CHROMIUM`, or a build in `~/.cache/ms-playwright`.
 * Skips loudly when none exists — full Playwright CI infra is the visual
 * track's 5F deliverable; until it lands, this leg runs wherever a local
 * Chromium is present.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright-core';
import { PACKAGE_ROOT } from './node-grammar-source.js';

function findChromium(): string | undefined {
  const fromEnv = process.env['MERIDIAN_CHROMIUM'];
  if (fromEnv !== undefined && fromEnv !== '' && existsSync(fromEnv)) return fromEnv;
  const cache = resolve(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(cache)) return undefined;
  const candidates: string[] = [];
  for (const entry of readdirSync(cache)) {
    if (entry.startsWith('chromium_headless_shell-')) {
      candidates.push(join(cache, entry, 'chrome-headless-shell-linux64', 'chrome-headless-shell'));
    } else if (entry.startsWith('chromium-')) {
      candidates.push(join(cache, entry, 'chrome-linux', 'chrome'));
    }
  }
  return candidates.filter((path) => existsSync(path)).sort().at(-1);
}

const CHROMIUM = findChromium();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
};

/** The test page: imports the built shim, exercises it, posts results. */
const PAGE = `<!doctype html>
<html>
<head>
<script type="importmap">
{
  "imports": {
    "web-tree-sitter": "/wts/web-tree-sitter.js",
    "comlink": "/comlink/dist/esm/comlink.mjs"
  }
}
</script>
</head>
<body>
<script type="module">
  const report = { ok: false };
  try {
    const { createParserRuntime, parseSource, GRAMMAR_FILES, CODE_LANGUAGES } =
      await import('/dist/index.js');
    const runtime = await createParserRuntime({
      locateFile: () => '/wts/web-tree-sitter.wasm',
      readGrammar: async (language) => {
        const res = await fetch('/grammars/' + GRAMMAR_FILES[language]);
        if (!res.ok) throw new Error('HTTP ' + res.status + ' fetching grammar');
        return new Uint8Array(await res.arrayBuffer());
      },
    });
    const outcomes = {};
    const sources = {
      typescript: ['const x: number = 1;', 'const = {{{'],
      python: ['x = 1', 'def broken(:'],
    };
    for (const language of CODE_LANGUAGES) {
      const parser = await runtime.parser(language);
      const [good, bad] = sources[language];
      const g = parseSource(parser, language, good);
      const b = parseSource(parser, language, bad);
      outcomes[language] = {
        rootType: g.outcome.rootType,
        cleanHasErrors: g.outcome.hasErrors,
        brokenHasErrors: b.outcome.hasErrors,
        brokenNodeCount: b.outcome.nodeCount,
      };
      g.tree.delete();
      b.tree.delete();
      parser.delete();
    }
    // Load-failure path in the browser: a fetch that 404s must surface as the
    // shim's located error.
    let loadFailure = '';
    const failing = await createParserRuntime({
      locateFile: () => '/wts/web-tree-sitter.wasm',
      readGrammar: async () => {
        const res = await fetch('/grammars/no-such-grammar.wasm');
        if (!res.ok) throw new Error('HTTP ' + res.status + ' fetching grammar');
        return new Uint8Array(await res.arrayBuffer());
      },
    });
    try {
      await failing.language('python');
    } catch (error) {
      loadFailure = String(error && error.message);
    }
    report.outcomes = outcomes;
    report.loadFailure = loadFailure;
    report.ok = true;
  } catch (error) {
    report.error = String(error && error.stack || error);
  }
  window.__MERIDIAN_7B__ = report;
</script>
</body>
</html>`;

function startServer(): Promise<Server> {
  const roots: Record<string, string> = {
    '/dist/': join(PACKAGE_ROOT, 'dist'),
    '/grammars/': join(PACKAGE_ROOT, 'grammars'),
    '/wts/': join(PACKAGE_ROOT, 'node_modules', 'web-tree-sitter'),
    '/comlink/': join(PACKAGE_ROOT, 'node_modules', 'comlink'),
  };
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'content-type': MIME['.html']! });
      res.end(PAGE);
      return;
    }
    const prefix = Object.keys(roots).find((p) => url.startsWith(p));
    if (prefix !== undefined) {
      const rel = normalize(url.slice(prefix.length)).replace(/^([.][.][/\\])+/, '');
      const file = join(roots[prefix]!, rel);
      if (file.startsWith(roots[prefix]!) && existsSync(file)) {
        res.writeHead(200, {
          'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        });
        res.end(readFileSync(file));
        return;
      }
    }
    res.writeHead(404).end('not found');
  });
  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => resolveServer(server));
  });
}

interface BrowserReport {
  ok: boolean;
  error?: string;
  loadFailure?: string;
  outcomes?: Record<
    string,
    { rootType: string; cleanHasErrors: boolean; brokenHasErrors: boolean; brokenNodeCount: number }
  >;
}

let browser: Browser | undefined;
let server: Server | undefined;
afterAll(async () => {
  await browser?.close();
  server?.close();
});

describe.skipIf(CHROMIUM === undefined)('grammar-loading shim (headless browser)', () => {
  it('loads both grammars over HTTP, parses, and locates load failures', async () => {
    server = await startServer();
    const { port } = server.address() as AddressInfo;
    browser = await chromium.launch({ executablePath: CHROMIUM!, headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(
      () => (globalThis as unknown as { __MERIDIAN_7B__?: unknown }).__MERIDIAN_7B__ !== undefined,
      undefined,
      { timeout: 20_000 },
    );
    const report = (await page.evaluate(
      () => (globalThis as unknown as { __MERIDIAN_7B__: unknown }).__MERIDIAN_7B__,
    )) as BrowserReport;

    expect(report.error).toBeUndefined();
    expect(report.ok).toBe(true);
    expect(report.outcomes!['typescript']).toMatchObject({
      rootType: 'program',
      cleanHasErrors: false,
      brokenHasErrors: true,
    });
    expect(report.outcomes!['python']).toMatchObject({
      rootType: 'module',
      cleanHasErrors: false,
      brokenHasErrors: true,
    });
    expect(report.outcomes!['python']!.brokenNodeCount).toBeGreaterThan(0);
    expect(report.loadFailure).toContain('"python"');
    expect(report.loadFailure).toContain('HTTP 404');
  });
});

describe.runIf(CHROMIUM === undefined)('grammar-loading shim (headless browser) — SKIPPED', () => {
  it('no local Chromium found (set MERIDIAN_CHROMIUM or install a playwright browser)', () => {
    console.warn(
      'adapter-code browser smoke SKIPPED: no Chromium at $MERIDIAN_CHROMIUM or ~/.cache/ms-playwright',
    );
    expect(CHROMIUM).toBeUndefined();
  });
});
