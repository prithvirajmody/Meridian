import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // The sqlite WASM binding self-locates its .wasm asset; Vite's dep
  // optimizer would break that. It is only ever imported by the storage
  // worker chunk (ADR-0038).
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  // The renderer owns its checked-in MSDF font. Vite serves/copies that local
  // asset directory; Studio neither duplicates it nor fetches a remote font.
  publicDir: fileURLToPath(new URL('../../packages/renderer/assets', import.meta.url)),
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    strictPort: true,
  },
});
