import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// NOTE: The Gemini API key is intentionally NOT exposed to the client here.
// All AI calls go through the Netlify function at /api/generate, which reads
// GEMINI_API_KEY server-side. For local dev, run `netlify dev` (which serves
// the functions) instead of `vite` alone.
export default defineConfig({
  server: {
    port: 3000,
    host: '0.0.0.0',
    // Proxy API calls to the local Netlify Functions dev server when using
    // `vite` standalone alongside `netlify functions:serve`.
    proxy: {
      '/api': {
        target: 'http://localhost:8888',
        changeOrigin: true,
      },
    },
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
