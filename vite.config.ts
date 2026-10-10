import { defineConfig } from 'vite';

// Quick tunnels (cloudflared) for testing on other devices.
const allowedHosts = ['.trycloudflare.com'];

export default defineConfig({
  base: './',
  server: { port: 4791, host: true, allowedHosts },
  preview: { port: 4792, host: true, allowedHosts },
  build: { chunkSizeWarningLimit: 900 },
});
