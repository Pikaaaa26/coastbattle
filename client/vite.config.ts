import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

// Coast Battle client. In dev, `/ws` is proxied to the node server on :8787.
// In prod, the node server serves this build AND handles `/ws` on one port.
export default defineConfig({
  root: here,
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(repoRoot, 'shared'),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    fs: { allow: [repoRoot] },
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true, changeOrigin: true },
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
  build: {
    outDir: path.resolve(repoRoot, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
  },
});
