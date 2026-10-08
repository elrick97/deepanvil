import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    // Dev server on IPv4 loopback only: nothing else on the LAN sees it (phones use the always-on forge).
    host: '127.0.0.1',
    // Reached from the iPhone through Tailscale Serve (https://<pc>.<tailnet>.ts.net).
    allowedHosts: ['.ts.net'],
    proxy: {
      // The forge server runs in WSL; WSL2 forwards its localhost ports to Windows.
      '/ws': { target: 'ws://localhost:8787', ws: true },
      '/health': { target: 'http://localhost:8787' },
    },
  },
  // three.js alone is ~1 MB; one cached chunk is fine for a single-page world.
  build: { target: 'es2023', chunkSizeWarningLimit: 1600 },
});
