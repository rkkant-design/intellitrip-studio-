import path from 'path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// NOTE: The OpenAI API key is intentionally NOT exposed to the client here.
// All AI calls go through the Netlify functions at /api/*, which read
// OPENAI_API_KEY server-side. Run `netlify dev`, or `npm run dev:local`, which
// serves the same functions from Vite without the Netlify CLI.

// Runs netlify/functions/<name>.ts for /api/<name> during `vite` dev, so the app
// can be tested locally without the Netlify CLI. Not used in production builds.
function localFunctions(): Plugin {
  return {
    name: 'local-netlify-functions',
    apply: 'serve',
    configureServer(server) {
      // Server-side env (OPENAI_API_KEY etc.) from .env, for the functions only.
      Object.assign(process.env, loadEnv('development', process.cwd(), ''));
      server.middlewares.use(async (req, res, next) => {
        const match = /^\/api\/([a-z]+)(?:\?|$)/.exec(req.url || '');
        if (!match) return next();
        try {
          const mod = await server.ssrLoadModule(`/netlify/functions/${match[1]}.ts`);
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const url = new URL(req.url || '/', 'http://localhost');
          const out = await mod.handler({
            httpMethod: req.method,
            headers: req.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            queryStringParameters: Object.fromEntries(url.searchParams),
          }, {});
          res.statusCode = out.statusCode;
          for (const [k, v] of Object.entries(out.headers || {})) res.setHeader(k, String(v));
          res.end(out.body);
        } catch (err) {
          console.error(err);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Local function failed. See the terminal.' }));
        }
      });
    },
  };
}

const underNetlifyDev = Boolean(process.env.NETLIFY_DEV);

export default defineConfig({
  server: {
    port: 3000,
    // Local only: the dev server runs the AI functions with your OpenAI key, so keep it off the Wi-Fi.
    host: 'localhost',
    // Under `netlify dev`, the Netlify CLI serves the functions on 8888.
    proxy: underNetlifyDev ? { '/api': { target: 'http://localhost:8888', changeOrigin: true } } : undefined,
  },
  plugins: [react(), ...(underNetlifyDev ? [] : [localFunctions()])],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
