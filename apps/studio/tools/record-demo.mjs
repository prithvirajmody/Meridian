/** Deterministic Phase-5 demo recording: real corpus pipeline, select/panel, then 10k pan/zoom. */
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STUDIO = join(HERE, '..');
const DIST = join(STUDIO, 'dist');
const ROOT = join(STUDIO, '..', '..');
const OUTPUT = join(ROOT, 'docs', 'demos', 'phase-05.webm');
const CORPUS = join(ROOT, 'fixtures', 'corpora', 'markdown', 'links.md');
const VIDEO_DIR = join(ROOT, '.tmp-phase-5-video');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.fnt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

if (!existsSync(join(DIST, 'index.html'))) throw new Error('Build Studio before recording the demo');

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const candidate = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = normalize(join(DIST, candidate));
  if (!file.startsWith(DIST) || !existsSync(file)) {
    response.statusCode = 404;
    response.end('not found');
    return;
  }
  response.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
  response.end(readFileSync(file));
});

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const browser = await chromium.launch({
    args: [
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--ignore-gpu-blocklist',
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: VIDEO_DIR, size: { width: 1280, height: 800 } },
    colorScheme: 'dark',
  });
  const page = await context.newPage();
  const video = page.video();
  try {
    await page.goto(`http://127.0.0.1:${port}/?e2e=1&debug=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => globalThis.__MERIDIAN_STUDIO__ !== undefined);
    await page.getByTestId('file-input').setInputFiles(CORPUS);
    await page.getByTestId('pipeline-phase').waitFor();
    await page.waitForFunction(() => globalThis.__MERIDIAN_STUDIO__.state().phase === 'ready');
    await page.waitForTimeout(1_000);

    const canvas = page.getByTestId('graph-canvas');
    const box = await canvas.boundingBox();
    if (box === null) throw new Error('Demo canvas is not visible');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let index = 0; index < 8; index++) {
      await page.mouse.wheel(0, index < 5 ? -180 : 120);
      await page.waitForTimeout(160);
    }

    // The wheel choreography leaves an arbitrary camera; re-fit so the target
    // node is guaranteed back inside the canvas before hover/select.
    await page.evaluate(() => globalThis.__MERIDIAN_STUDIO__.fit());
    await page.waitForTimeout(400);
    const nodeId = await page.evaluate(() => globalThis.__MERIDIAN_STUDIO__.state().nodeIds[0]);
    let point = await page.evaluate(
      (id) => globalThis.__MERIDIAN_STUDIO__.screenPointForNode(id),
      nodeId,
    );
    if (
      point !== null &&
      (point.x < 1 || point.y < 1 || point.x > box.width - 1 || point.y > box.height - 1)
    ) {
      point = null;
    }
    if (point !== null) {
      await canvas.hover({ position: point });
      await page.waitForTimeout(600);
      await canvas.click({ position: point });
      await page.waitForTimeout(1_200);
    }

    await page.evaluate(() => globalThis.__MERIDIAN_STUDIO__.openPerformanceFixture());
    await page.waitForFunction(() => globalThis.__MERIDIAN_STUDIO__.state().rendererStats?.modelNodes === 10_000);
    await page.evaluate(() => globalThis.__MERIDIAN_STUDIO__.runFrameProbe(180, 30));
    await page.waitForTimeout(800);
  } finally {
    await page.close();
    await context.close();
    if (video !== null) await video.saveAs(OUTPUT);
    await browser.close();
    server.close();
  }
  console.log(`recorded ${OUTPUT}`);
}

main().catch((error) => {
  console.error(error);
  server.close();
  process.exit(1);
});
