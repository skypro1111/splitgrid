import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // Monaco + VSCode language chunks can be brittle when heavily minified.
    // Electron apps are not network-constrained, so prioritize runtime stability.
    minify: false,
  },
  server: {
    watch: {
      usePolling: true,
      interval: 1000,
    },
  },
  optimizeDeps: {
    exclude: ['monaco-editor'],
  },
});
