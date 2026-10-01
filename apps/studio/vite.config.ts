import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // The sqlite WASM binding self-locates its .wasm asset; Vite's dep
  // optimizer would break that. It is only ever imported by the storage
  // worker chunk (ADR-0038).
  // web-tree-sitter is only imported by the code worker, which the startup
  // dependency scan does not reach. Discovered on first use, it made the dev
  // server re-optimize and reload open pages mid-session (the first-attempt
  // "Execution context was destroyed" in code-streaming-ingest.spec.ts), so
  // pre-bundle it at startup.
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm'],
    include: ['web-tree-sitter'],
  },
  // The renderer owns its checked-in MSDF font. Vite serves/copies that local
  // asset directory; Studio neither duplicates it nor fetches a remote font.
  publicDir: fileURLToPath(new URL('../../packages/renderer/assets', import.meta.url)),
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  worker: {
    format: 'es',
  },
  server: {
    strictPort: true,
  },
});
