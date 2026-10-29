import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const serverTarget = process.env.COLLAB_SERVER_URL ?? 'http://127.0.0.1:1234';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [tailwindcss()],
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    // Dev runs two processes; proxying keeps the client's origin single, which
    // means no CORS and no separate WebSocket URL to configure.
    proxy: {
      '/ws': { target: serverTarget, ws: true },
      '/api': { target: serverTarget },
      '/healthz': { target: serverTarget },
      '/metrics': { target: serverTarget },
    },
  },
});
