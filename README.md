# Google Maps Grid Rank Tracker — Standalone

Standalone, domain-ready version of the Rank Checker built for the Pearce Studios website. Same engine, its own page.

## What it does
1. Visitor enters their **own DataForSEO API login + password** (per-request only, never stored or logged) and can test the connection.
2. Searches for their business by name + city + state, clicks their exact listing — the OpenStreetMap map immediately shows (in its own visible preview section, never inside a hidden container) with the grid **pre-loaded**: a ★ marker on the business and blue dots on every point that will be checked, using the same grid math as the scan. Changing grid size or spacing updates the preview instantly. The grid centers on the business itself, not the city center.
3. Runs a geo-grid scan for a keyword: **3×3 to 13×13**, spacing **0.5 / 1 / 2 / 3 / 5 / 10 miles**.

## Scan rules (carried over exactly from the Pearce checker)
- DataForSEO Live accepts **one task per POST** — every grid point is requested individually, 5 at a time. Never batch Live tasks.
- **Depth 100 first**, retry that point once at depth 20 if it errors or comes back empty.
- Matching is three-way, in order: **place_id → coordinates within 0.002° → loose name match** (legal suffixes stripped). Each point reports how it matched and how many listings were checked.
- A failed point shows its real error — never a fake "not found." If every point fails (e.g. bad credentials), the whole scan fails with that error.
- Map tiles: OpenStreetMap only, served through the site's own `/tiles/{z}/{x}/{y}.png` proxy with an identifying User-Agent and in-memory cache. **No CARTO.**
- No lead capture. After results, a "Call 510-619-0213" help CTA (change the number in `index.html` if this brand differs).

## Run locally
```bash
node server.js   # Node 18+, no npm install needed
# open http://localhost:8080
```

## Deploy when the domain is ready (Railway)
1. Create an empty **private** GitHub repo (Nelson creates it — agent repo creation hits a permission error), tell Kai the repo name, and he'll push this package.
2. In Railway: New Project → Deploy from that GitHub repo. No build command needed; start command is `node server.js` (Procfile included).
3. Point the new domain at Railway (custom domain in Railway → add the CNAME it gives you at your registrar).
4. Optional but recommended: set `TILE_UA` in Railway variables to identify the site to OpenStreetMap, e.g. `MapsGridRankTracker/1.0 (https://yourdomain.com; you@yourdomain.com)`.
5. Final proof: run one real scan with a real DataForSEO key on the live domain (start small — 3×3 — to waste few credits if anything's off).

## Files
- `server.js` — API routes (`/api/rank/test`, `/api/rank/search`, `/api/rank/scan`), tile proxy, static serving
- `index.html` — the whole page (Leaflet map, steps 1–3, summary, pins, per-point table)
