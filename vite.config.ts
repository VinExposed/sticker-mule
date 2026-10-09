import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 4791, host: true },
  build: { chunkSizeWarningLimit: 900 },
});
