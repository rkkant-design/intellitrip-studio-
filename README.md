# IntelliTrip Studio

High-fidelity AI travel architecture. A React + Vite single-page app that generates
cinematic, INR-costed itineraries and a matching AI "vibe" image via the Google Gemini API.

The Gemini API key is **never** exposed to the browser — all AI calls run through a
Netlify serverless function (`netlify/functions/generate.ts`) that reads the key from a
server-side environment variable.

## Architecture

```
Browser (React SPA)  ──POST /api/generate──►  Netlify Function  ──►  Gemini API
        │                                       (holds GEMINI_API_KEY)
        └── renders itinerary + vibe image ◄────── JSON response ◄──
```

## Local development

**Prerequisites:** Node.js 20+, and the [Netlify CLI](https://docs.netlify.com/cli/get-started/)
(`npm i -g netlify-cli`) so the serverless function runs locally.

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create a `.env` from the template and add your key:
   ```bash
   cp .env.example .env
   # then edit .env and set GEMINI_API_KEY
   ```
3. Run the app (serves the Vite frontend *and* the function):
   ```bash
   npm run dev
   ```
   Open http://localhost:8888.

> `npm run dev:vite` runs the frontend alone (no API). Use `npm run dev` for the full app.

## Deploy to Netlify

This repo is Netlify-ready (`netlify.toml` sets the build command, publish dir, functions
dir, and redirects).

1. Push this repo to GitHub.
2. In Netlify: **Add new site → Import an existing project**, pick the repo.
   Build settings are read from `netlify.toml` (no manual config needed).
3. Under **Site settings → Environment variables**, add:
   - `GEMINI_API_KEY` = your Gemini key
   - *(optional)* `GEMINI_TEXT_MODEL`, `GEMINI_IMAGE_MODEL`
4. Deploy. Netlify builds the frontend to `dist/` and deploys the function to `/api/generate`.

## Features in the Briefing tab

- **Live weather** — real geocoding + 7-day forecast via [Open-Meteo](https://open-meteo.com)
  (free, no key required).
- **Live traffic map** — Mapbox GL with live congestion tiles. Set `VITE_MAPBOX_TOKEN`
  (a public `pk.…` token) in your env / Netlify to enable it; restrict the token by URL in
  your Mapbox account. Without it, the map shows a "not configured" placeholder and the rest
  of the app is unaffected.

## Notes

- **AI advisories** in the Briefing are generated alongside your itinerary as planning
  guidance — they are not a live real-time feed (weather and traffic above are live).
- The "login" is a display-name only (no auth). Add a real auth provider before handling
  any user data.
- Archives are stored in the browser's `localStorage`.
