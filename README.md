# IntelliTrip Studio

High-fidelity AI travel architecture. A React + Vite single-page app that plans road trips
and holidays: real routes with named stops and food on the way, hidden gems, day cards with
"Hero Moments", INR budgets, booking deadlines and packing lists. It merges the original
IntelliTrip with the Trip Kit planner, and uses the OpenAI API (gpt-5 with web search).

The OpenAI API key is **never** exposed to the browser. All AI calls run through Netlify
serverless functions that read the key from a server-side environment variable.

## Architecture

A plan takes a few minutes (the model searches the web for routes, places and rules), far
longer than a Netlify function may run. So the work runs as an OpenAI **background job**:

```
Browser ──POST /api/plan──►  plan.ts  ──start job──►  OpenAI (background mode)
   │        ◄── { jobId } ───┘
   └──every 4 s: GET /api/job?id=…──►  job.ts  ──check──►  OpenAI
            ◄── running | done + cleaned plan | error
```

- `netlify/functions/plan.ts`, `pack.ts` start a trip plan or a packing list.
- `netlify/functions/job.ts` reports on a job, cleans the result, or cancels it.
- `netlify/shared/` holds the request gates (same-origin, Firebase login once enabled, rate
  limit), the OpenAI helpers and the prompts.
- The browser remembers a running job in `localStorage`, so closing the page or reloading
  does not lose the plan; it is saved to Archives when it finishes.

## Local development

**Prerequisites:** Node.js 20+.

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create a `.env` from the template and add your key:
   ```bash
   cp .env.example .env
   # then edit .env and set OPENAI_API_KEY
   ```
3. Run the app with the functions:
   ```bash
   npm run dev:local
   ```
   Open http://localhost:3000. This serves the functions straight from Vite, so the
   Netlify CLI is optional (`npm run dev` uses it if installed).

## Deploy to Netlify

This repo is Netlify-ready (`netlify.toml` sets the build command, publish dir, functions
dir, and redirects).

1. Push this repo to GitHub.
2. In Netlify: **Add new site → Import an existing project**, pick the repo.
3. Under **Site settings → Environment variables**, add (scope: Functions):
   - `OPENAI_API_KEY` = your OpenAI key
   - *(optional)* `OPENAI_MODEL` (default `gpt-5`), `REASONING_EFFORT` (default `low`),
     `WEB_SEARCH`, `MAX_SEARCHES`
4. Deploy. Netlify builds the frontend to `dist/` and deploys the functions under `/api/*`.

## Tabs

- **Architect** plans a trip: from/to, dates, travellers, vibe, how you're travelling, most
  driving per day, budget and food. The plan shows a Road Trip section (route options,
  stop-by-stop drives with Google Maps links, where to eat, driving tips, a warning when a
  drive exceeds your daily limit), day cards with hidden gems and Hero Moments, a stay pick,
  budget, booking deadlines, documents, sources and a packing list.
- **Today** is the screen for the road. On a trip day it opens by itself: the day's drive and
  plan as a timeline you tick off, a big Navigate button for the next stop (Google Maps, to the
  exact spot when the map check found it), today's road-rule warnings, quick spend entry, the
  weather and today's map with live traffic. It works offline once the app is installed.
- The plan view has a **Trip Map**: each day's real road (from the map check) in its own colour,
  with pins for the stay, food stops, sights and hidden gems (Mapbox GL; `VITE_MAPBOX_TOKEN`).
- **Archives** keeps every plan in this browser and imports trip files from the laptop
  Trip Kit app.
- **Toolkit** holds the Travellers profile (used by every plan), the Book By calculator and
  the Leave-Home checklist. These work without AI.

## Notes

- AI advisories are planning guidance, not a live feed (weather and traffic are live).
- The "login" is a display-name only until Firebase is configured (see `.env.example`).
- Trips are saved in the browser first, then synced through Firestore for signed-in users.
- **Plan together**: Share → Invite family moves a trip to `shared/{tripId}` in Firestore and
  gives an invite link. Members see changes live; ticks, Today's done stops and spends from
  several phones are merged field by field. `firestore.rules` must be published for this.
- **Install as an app**: `public/manifest.webmanifest` and `public/sw.js` make the site
  installable and let it open offline (production builds only).
