/**
 * Local frame-budget probe for the 10k-node labelled fixture (ADR-0020/0021).
 *
 *   pnpm --filter @meridian/renderer harness:build
 *   node tools/fps-probe.mjs
 *
 * Serves the built harness, drives its scripted pan/zoom in headless Chromium
 * (SwiftShader WebGL) via playwright-core, and reports both renderer draw cost
 * and wall-clock requestAnimationFrame cadence. Either p95 crossing 18ms exits
 * nonzero; the probe also fails if the 10k fixture draws no labels.
 * This is a LOCAL probe only; the enforced CI FPS gate lands in subphase 5F.
 */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', 'harness', 'dist');

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('fps-probe: build the harness first (pnpm --filter @meridian/renderer harness:build)');
  process.exit(1);
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.fnt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/favicon.ico') {
    response.statusCode = 204;
    response.end();
    return;
  }
  const path = normalize(join(DIST, decodeURIComponent(url.pathname)));
  const file = url.pathname === '/' ? join(DIST, 'index.html') : path;
  if (!file.startsWith(DIST) || !existsSync(file)) {
    response.statusCode = 404;
    response.end('not found');
    return;
  }
  response.setHeader('content-type', CONTENT_TYPES[extname(file)] ?? 'application/octet-stream');
  response.end(readFileSync(file));
});

function executablePath() {
  const override = process.env.MERIDIAN_CHROMIUM;
  if (override && existsSync(override)) return override;
  const cache = join(
    process.env.HOME ?? '',
    '.cache/ms-playwright/chromium-1223/chrome-linux64/chrome',
  );
  return existsSync(cache) ? cache : chromium.executablePath();
}

async function withTimeout(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = globalThis.setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    globalThis.clearTimeout(timer);
  }
}

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const browser = await chromium.launch({
    executablePath: executablePath(),
    args: [
      '--no-sandbox',
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--ignore-gpu-blocklist',
      // Headless BeginFrame quantizes RAF to 30Hz once software compositing
      // exceeds one vsync; unthrottled cadence is the budget-relevant number.
      '--disable-frame-rate-limit',
      '--disable-gpu-vsync',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (error) => console.error('page error:', error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      console.error(`page ${message.type()}:`, message.text());
    }
  });
  page.on('requestfailed', (request) => {
    console.error('request failed:', request.url(), request.failure()?.errorText ?? 'unknown');
  });
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(globalThis.__MERIDIAN_HARNESS__), null, { timeout: 10_000 });
    await withTimeout(
      page.evaluate(() => globalThis.__MERIDIAN_HARNESS__.ready),
      30_000,
      'renderer harness mount timed out after 30s',
    );
    const result = await page.evaluate(() => globalThis.__MERIDIAN_HARNESS__.runFpsProbe());
    console.log(JSON.stringify(result, null, 2));
    const budget = 18;
    const failures = [];
    if (result.p95DrawTimeMs > budget) {
      failures.push(`draw p95 ${result.p95DrawTimeMs.toFixed(2)}ms > ${budget}ms`);
    }
    if (result.p95RafIntervalMs > budget) {
      failures.push(`RAF p95 ${result.p95RafIntervalMs.toFixed(2)}ms > ${budget}ms`);
    }
    if (result.modelNodes !== 10_000) {
      failures.push(`fixture has ${result.modelNodes} nodes, expected 10000`);
    }
    if (result.minLiveLabels < 1 || result.maxBitmapLabelCount < 1) {
      failures.push(
        `label path not exercised (minLive=${result.minLiveLabels}, maxBitmap=${result.maxBitmapLabelCount})`,
      );
    }

    if (failures.length === 0) {
      console.log(
        `PASS draw p95 ${result.p95DrawTimeMs.toFixed(2)}ms; RAF p95 ${result.p95RafIntervalMs.toFixed(2)}ms; labels ${result.minLiveLabels}-${result.maxLiveLabels}`,
      );
    } else {
      for (const failure of failures) console.error(`FAIL ${failure}`);
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  server.close();
  process.exit(1);
});
