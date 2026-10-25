import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  root,
  plugins: [react()],
  // pet.html is the desktop pet that Chumi.app floats over other windows (web/src/pet/).
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, rolldownOptions: { input: { main: `${root}index.html`, pet: `${root}pet.html` } } },
  // The backend validates Host against its own loopback address and port.
  server: { port: 5177, proxy: { '/api': { target: 'http://127.0.0.1:4777', changeOrigin: true } } },
});
