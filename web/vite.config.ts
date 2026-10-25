import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  root,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  // The backend validates Host against its own loopback address and port.
  server: { port: 5177, proxy: { '/api': { target: 'http://127.0.0.1:4777', changeOrigin: true } } },
});
