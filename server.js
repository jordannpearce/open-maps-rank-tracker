// Standalone Google Maps Grid Rank Tracker — domain-ready
// Same engine as the Pearce Studios Rank Checker:
//   POST /api/rank/test   — validate a visitor's own DataForSEO credentials
//   POST /api/rank/search — find a business via DataForSEO Google Maps API
//   POST /api/rank/scan   — geo-grid rank scan (3x3-13x13) via DataForSEO
//   GET  /tiles/z/x/y.png — OpenStreetMap tile proxy (identifying UA + cache)
// Visitors' DataForSEO credentials are used per-request only and are
// NEVER stored, logged, or sent anywhere except DataForSEO.
// Host variables:
//   PORT     (set automatically by Railway)
//   TILE_UA  (optional) identifying User-Agent for the OSM tile proxy,
//            e.g. "YourBrand/1.0 (https://yourdomain.com; you@yourdomain.com)"
//            Set this once your domain is live — OSM asks apps to identify themselves.

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const DFS_BASE = "https://api.dataforseo.com";
const GEO_UA = process.env.TILE_UA || "MapsGridRankTracker/1.0 (standalone rank tracker)";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function readJsonBody(req, limit) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > (limit || 64 * 1024)) req.destroy();
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve(null); }
    });
    req.on("error", () => resolve(null));
  });
}

/* ---------------- Rank Checker (DataForSEO, visitor's own key) ---------------- */

function dfsAuth(login, password) {
  return "Basic " + Buffer.from(login + ":" + password).toString("base64");
}

async function dfsMapsLive(login, password, tasks, signal) {
  const res = await fetch(DFS_BASE + "/v3/serp/google/maps/live/advanced", {
    method: "POST",
    headers: {
      Authorization: dfsAuth(login, password),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(tasks),
    signal,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { httpStatus: res.status, data };
}

function dfsCredsError(httpStatus, data) {
  if (httpStatus === 401 || (data && data.status_code === 40100)) {
    return "DataForSEO rejected those credentials (401 Unauthorized). Check your API login and password.";
  }
  if (data && data.status_message && data.status_code >= 40000) {
    return "DataForSEO error " + data.status_code + ": " + data.status_message;
  }
  return "DataForSEO request failed (HTTP " + httpStatus + ").";
}

async function geocodeCity(city, state) {
  const q = encodeURIComponent(city + ", " + state + ", USA");
  const res = await fetch(
    "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=" + q,
    { headers: { "User-Agent": GEO_UA, "Accept-Language": "en" } }
  );
  if (!res.ok) return null;
  const arr = await res.json();
  if (!Array.isArray(arr) || !arr.length) return null;
  const lat = parseFloat(arr[0].lat);
  const lng = parseFloat(arr[0].lon);
  if (!isFinite(lat) || !isFinite(lng)) return null;
  return { lat, lng };
}

async function geocodePlace(query) {
  try {
    const q = encodeURIComponent(query);
    const res = await fetch(
      "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=" + q,
      { headers: { "User-Agent": GEO_UA, "Accept-Language": "en" } }
    );
    if (!res.ok) return null;
    const arr = await res.json();
    if (!Array.isArray(arr) || !arr.length) return null;
    const lat = parseFloat(arr[0].lat);
    const lng = parseFloat(arr[0].lon);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    return { lat, lng };
  } catch {
    return null;
  }
}

function taskItems(taskResult) {
  if (!taskResult || !Array.isArray(taskResult.result) || !taskResult.result.length)
    return [];
  const items = taskResult.result[0].items;
  return Array.isArray(items) ? items : [];
}

// Scan results can span multiple entries in task.result; collect items from
// ALL of them. (taskItems above deliberately reads only the first entry,
// which is what the business search relies on.)
function taskItemsAll(taskResult) {
  if (!taskResult || !Array.isArray(taskResult.result)) return [];
  const all = [];
  for (const entry of taskResult.result) {
    if (entry && Array.isArray(entry.items)) all.push(...entry.items);
  }
  return all;
}

function mapSearchItem(item, center) {
  const rating = item.rating || {};
  // Only trust coordinates the item actually carries. Substituting the city
  // center here made the page center the scan grid on the city instead of
  // the business, so most grid points missed it. Missing coords stay null;
  // handleRankSearch resolves the exact-match listing separately.
  const hasCoords =
    typeof item.latitude === "number" && typeof item.longitude === "number";
  return {
    title: String(item.title || ""),
    address: String(item.address || ""),
    rating: typeof rating.value === "number" ? rating.value : null,
    ratingCount: typeof rating.votes_count === "number" ? rating.votes_count : null,
    category: String(item.category || ""),
    placeId: item.place_id || null,
    lat: hasCoords ? item.latitude : null,
    lng: hasCoords ? item.longitude : null,
  };
}

async function handleRankTest(req, res) {
  const body = await readJsonBody(req);
  if (!body) return sendJson(res, 400, { ok: false, error: "Invalid request." });
  const login = String(body.login || "").trim();
  const password = String(body.password || "");
  if (!login || !password)
    return sendJson(res, 400, { ok: false, error: "Enter your DataForSEO API login and password." });
  try {
    const r = await fetch(DFS_BASE + "/v3/appendix/user_data", {
      headers: { Authorization: dfsAuth(login, password) },
    });
    if (r.ok) return sendJson(res, 200, { ok: true });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return sendJson(res, 200, { ok: false, error: dfsCredsError(r.status, data) });
  } catch (err) {
    return sendJson(res, 200, { ok: false, error: "Could not reach DataForSEO: " + err.message });
  }
}

async function handleRankSearch(req, res) {
  const body = await readJsonBody(req);
  if (!body) return sendJson(res, 400, { ok: false, error: "Invalid request." });
  const login = String(body.login || "").trim();
  const password = String(body.password || "");
  const business = String(body.business || "").trim().slice(0, 160);
  const city = String(body.city || "").trim().slice(0, 80);
  const state = String(body.state || "").trim().slice(0, 80);
  if (!login || !password)
    return sendJson(res, 400, { ok: false, error: "Enter your DataForSEO API login and password." });
  if (!business || !city || !state)
    return sendJson(res, 400, { ok: false, error: "Enter the business name, city, and state." });

  const center = await geocodeCity(city, state);
  if (!center)
    return sendJson(res, 200, { ok: false, error: "Could not find that city and state. Check the spelling and try again." });

  const debug = { geocoded: center, attempts: [] };
  const attempts = [
    { keyword: business, zoom: "13z" },
    { keyword: business + " " + city + " " + state, zoom: "11z" },
  ];
  for (const attempt of attempts) {
    const coordinate = center.lat + "," + center.lng + "," + attempt.zoom;
    let out;
    try {
      out = await dfsMapsLive(login, password, [
        {
          keyword: attempt.keyword,
          language_code: "en",
          location_coordinate: coordinate,
          search_this_area: true,
          depth: 20,
        },
      ]);
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: "Could not reach DataForSEO: " + err.message, debug });
    }
    const task = out.data && Array.isArray(out.data.tasks) ? out.data.tasks[0] : null;
    const items = taskItems(task).filter((i) => i && i.title);
    debug.attempts.push({
      keyword: attempt.keyword,
      coordinate,
      httpStatus: out.httpStatus,
      status_code: task ? task.status_code : out.data ? out.data.status_code : null,
      status_message: task ? task.status_message : out.data ? out.data.status_message : null,
      items: items.length,
    });
    if (out.httpStatus === 401 || (out.data && out.data.status_code === 40100)) {
      return sendJson(res, 200, { ok: false, error: dfsCredsError(out.httpStatus, out.data), debug });
    }
    if (items.length) {
      const results = items.slice(0, 10).map((i) => mapSearchItem(i, center));
      // The single prominent result of an exact-name search often has no
      // coordinates. If the first exact-title listing is missing them,
      // resolve its real location so the scan grid centers on the business
      // itself rather than the city center.
      const targetName = normName(business);
      const exactIdx = results.findIndex(
        (r) => r.lat == null && normName(r.title) === targetName
      );
      if (exactIdx >= 0) {
        const place = await geocodePlace(
          results[exactIdx].title + ", " + city + ", " + state + ", USA"
        );
        if (place) {
          results[exactIdx].lat = place.lat;
          results[exactIdx].lng = place.lng;
          debug.businessGeocoded = { lat: place.lat, lng: place.lng };
        }
      }
      return sendJson(res, 200, { ok: true, center, results, debug });
    }
  }
  return sendJson(res, 200, {
    ok: false,
    error:
      "Google Maps returned no listings for that business name near this city. Try the exact name as it appears on your Google Business Profile.",
    center,
    debug,
  });
}

function normName(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

const NAME_SUFFIXES = new Set(["llc", "inc", "corp", "corporation", "co", "company", "ltd"]);

// Like normName, but also drops trailing legal-entity suffix tokens so
// "Acme Plumbing LLC" and "Acme Plumbing" compare equal.
function normNameLoose(s) {
  const tokens = normName(s).split(" ").filter(Boolean);
  while (tokens.length > 1 && NAME_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(" ");
}

function rankOfItem(item) {
  return typeof item.rank_group === "number" ? item.rank_group : item.rank_absolute;
}

// Find the business in one grid point's result items. Tries, in order:
// place_id equality, coordinate proximity (the business's real location
// identifies it even when Google formats its name differently), then a
// loose name match (equality or containment either direction).
// Returns { rank, matchedBy } or null.
function matchScanItem(items, biz) {
  if (biz.placeId) {
    for (const item of items) {
      if (item && item.place_id && item.place_id === biz.placeId)
        return { rank: rankOfItem(item), matchedBy: "place_id" };
    }
  }
  if (isFinite(biz.lat) && isFinite(biz.lng)) {
    for (const item of items) {
      if (
        item &&
        typeof item.latitude === "number" &&
        typeof item.longitude === "number" &&
        Math.abs(item.latitude - biz.lat) <= 0.002 &&
        Math.abs(item.longitude - biz.lng) <= 0.002
      )
        return { rank: rankOfItem(item), matchedBy: "coords" };
    }
  }
  const target = normNameLoose(biz.title);
  if (target) {
    for (const item of items) {
      if (!item || !item.title) continue;
      const cand = normNameLoose(item.title);
      if (!cand) continue;
      if (cand === target || cand.includes(target) || target.includes(cand))
        return { rank: rankOfItem(item), matchedBy: "name" };
    }
  }
  return null;
}

async function handleRankScan(req, res) {
  const body = await readJsonBody(req);
  if (!body) return sendJson(res, 400, { ok: false, error: "Invalid request." });
  const login = String(body.login || "").trim();
  const password = String(body.password || "");
  const keyword = String(body.keyword || "").trim().slice(0, 160);
  const biz = body.business || {};
  const title = String(biz.title || "").trim();
  const placeId = biz.placeId || null;
  const lat = parseFloat(biz.lat);
  const lng = parseFloat(biz.lng);
  const gridSize = parseInt(body.gridSize, 10);
  let spacing = parseFloat(body.spacingMiles);
  if (!login || !password)
    return sendJson(res, 400, { ok: false, error: "Enter your DataForSEO API login and password." });
  if (!keyword) return sendJson(res, 400, { ok: false, error: "Enter a keyword to rank for." });
  if (!title)
    return sendJson(res, 400, { ok: false, error: "Select your business first." });
  if (!isFinite(lat) || !isFinite(lng))
    return sendJson(res, 200, {
      ok: false,
      error:
        "We couldn't pin down that business's exact location from the search result. Try the search again — pick the listing that shows a street address.",
    });
  if (![3, 5, 7, 9, 13].includes(gridSize))
    return sendJson(res, 400, { ok: false, error: "Choose a grid size: 3x3, 5x5, 7x7, 9x9, or 13x13." });
  if (![0.5, 1, 2, 3, 5, 10].includes(spacing)) spacing = 1;

  const half = (gridSize - 1) / 2;
  const latStep = spacing / 69.0;
  const lngStep = spacing / (69.0 * Math.cos((lat * Math.PI) / 180));
  const coords = [];
  for (let r = half; r >= -half; r--) {
    for (let c = -half; c <= half; c++) {
      coords.push({ lat: lat + r * latStep, lng: lng + c * lngStep });
    }
  }

  const taskBase = coords.map((p) => ({
    keyword,
    language_code: "en",
    location_coordinate: p.lat.toFixed(7) + "," + p.lng.toFixed(7) + ",13z",
    search_this_area: true,
  }));

  // DataForSEO's Live method accepts only ONE task per POST request (per
  // their best-practices doc, "How to collect SERP data from DataForSEO
  // API"). The old code posted the whole grid in a single array, so only
  // the first point's task was ever processed and every other point came
  // back empty. Each point is now fetched individually, 5 at a time.
  const bizForMatch = { placeId, lat, lng, title };
  const points = new Array(coords.length);
  const pointDebug = new Array(coords.length);
  const debug = { tasks: pointDebug };
  let authFailure = null; // { httpStatus, data } from the first 401 response
  let firstError = null; // { code, message } from the first non-auth point error

  async function fetchPointTask(taskObj) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      return await dfsMapsLive(login, password, [taskObj], controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  async function scanPoint(idx) {
    const p = coords[idx];
    let depthUsed = 100;
    let last = null; // { task, items, fetchError } from the final attempt
    for (const depth of [100, 20]) {
      depthUsed = depth;
      let out = null;
      let fetchError = null;
      try {
        out = await fetchPointTask({ ...taskBase[idx], depth });
      } catch (err) {
        fetchError = err;
      }
      if (
        !fetchError &&
        out &&
        (out.httpStatus === 401 || (out.data && out.data.status_code === 40100))
      ) {
        authFailure = { httpStatus: out.httpStatus, data: out.data };
        return;
      }
      const task =
        !fetchError && out && out.data && Array.isArray(out.data.tasks)
          ? out.data.tasks[0]
          : null;
      const items = taskItemsAll(task);
      last = { task, items, fetchError };
      const taskErrored =
        !!fetchError ||
        !task ||
        (typeof task.status_code === "number" && task.status_code >= 40000);
      // Retry once at depth 20 when the deep attempt errored or came back
      // empty; otherwise this point is done.
      if (!(taskErrored || items.length === 0) || depth === 20) break;
    }
    const { task, items, fetchError } = last;
    const statusCode = task ? task.status_code : null;
    const statusMessage = task
      ? task.status_message
      : fetchError
        ? "Request failed: " + fetchError.message
        : "No task returned.";
    pointDebug[idx] = {
      status_code: statusCode,
      status_message: statusMessage,
      items: items.length,
      depthUsed,
    };
    const errored =
      !!fetchError ||
      !task ||
      (typeof statusCode === "number" && statusCode >= 40000);
    if (errored) {
      if (!firstError) firstError = { code: statusCode, message: statusMessage };
      points[idx] = {
        lat: p.lat,
        lng: p.lng,
        rank: null,
        found: false,
        itemsCount: null,
        matchedBy: null,
        topTitles: [],
        error: String(statusMessage || "DataForSEO task failed."),
      };
      return;
    }
    const match = matchScanItem(items, bizForMatch);
    const rank = match ? match.rank : null;
    points[idx] = {
      lat: p.lat,
      lng: p.lng,
      rank: rank == null ? null : rank,
      found: rank != null,
      itemsCount: items.length,
      matchedBy: match ? match.matchedBy : null,
      topTitles: items.slice(0, 3).map((it) => String((it && it.title) || "")),
    };
  }

  let nextPoint = 0;
  async function poolWorker() {
    while (!authFailure) {
      const idx = nextPoint++;
      if (idx >= coords.length) return;
      await scanPoint(idx);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(5, coords.length) }, () => poolWorker())
  );

  if (authFailure) {
    return sendJson(res, 200, {
      ok: false,
      error: dfsCredsError(authFailure.httpStatus, authFailure.data),
      debug,
    });
  }

  const errorCount = points.filter((pt) => pt && pt.error).length;
  if (points.length && errorCount === points.length) {
    const fe = firstError || { code: null, message: "Unknown error" };
    const label = fe.code != null ? fe.code + ": " + fe.message : String(fe.message);
    return sendJson(res, 200, {
      ok: false,
      error:
        "DataForSEO couldn't complete the scan tasks (" +
        label +
        "). No points could be checked.",
      debug,
    });
  }

  const foundRanks = points.filter((p) => p.found).map((p) => p.rank);
  const pct = (n) => (points.length ? Math.round((n / points.length) * 1000) / 10 : 0);
  const summary = {
    found: foundRanks.length,
    total: points.length,
    avgRank: foundRanks.length
      ? Math.round((foundRanks.reduce((a, b) => a + b, 0) / foundRanks.length) * 10) / 10
      : null,
    best: foundRanks.length ? Math.min(...foundRanks) : null,
    worst: foundRanks.length ? Math.max(...foundRanks) : null,
    top3Pct: pct(foundRanks.filter((r) => r <= 3).length),
    top10Pct: pct(foundRanks.filter((r) => r <= 10).length),
  };
  return sendJson(res, 200, { ok: true, points, summary, debug });
}

/* ---------------- Map tile proxy (OpenStreetMap) ---------------- */
// The Rank Checker map loads tiles same-origin from /tiles/{z}/{x}/{y}.png.
// This proxy fetches them from tile.openstreetmap.org with an identifying
// User-Agent (what OSM's tile usage policy asks of apps — generic browser
// user-agents get served a blocked-tile image) and caches them in memory.
// No other tile source is involved.

const TILE_UA = process.env.TILE_UA || "MapsGridRankTracker/1.0 (standalone rank tracker)";
const TILE_CACHE_MAX = 500;
const tileCache = new Map(); // key "z/x/y" -> { contentType, body }

async function handleTile(req, res, z, x, y) {
  const key = z + "/" + x + "/" + y;
  const hit = tileCache.get(key);
  if (hit) {
    // Refresh recency so frequently used tiles are evicted last.
    tileCache.delete(key);
    tileCache.set(key, hit);
    res.writeHead(200, {
      "Content-Type": hit.contentType,
      "Cache-Control": "public, max-age=86400",
    });
    return res.end(hit.body);
  }
  try {
    const upstream = await fetch(
      "https://tile.openstreetmap.org/" + z + "/" + x + "/" + y + ".png",
      { headers: { "User-Agent": TILE_UA } }
    );
    if (!upstream.ok) {
      return sendTileError(res, "Tile unavailable (OpenStreetMap returned " + upstream.status + ").");
    }
    const body = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get("content-type") || "image/png";
    if (tileCache.size >= TILE_CACHE_MAX) {
      tileCache.delete(tileCache.keys().next().value); // evict oldest
    }
    tileCache.set(key, { contentType, body });
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400",
    });
    return res.end(body);
  } catch (err) {
    return sendTileError(res, "Tile unavailable (" + err.message + ").");
  }
}

function sendTileError(res, message) {
  res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(message);
}


/* ---------------- Static + routing ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "POST" && url.pathname === "/api/rank/test") return await handleRankTest(req, res);
    if (req.method === "POST" && url.pathname === "/api/rank/search") return await handleRankSearch(req, res);
    if (req.method === "POST" && url.pathname === "/api/rank/scan") return await handleRankScan(req, res);
    const tileMatch = req.method === "GET" ? url.pathname.match(/^\/tiles\/(\d{1,2})\/(\d+)\/(\d+)\.png$/) : null;
    if (tileMatch) {
      const z = +tileMatch[1], x = +tileMatch[2], y = +tileMatch[3];
      if (z > 19 || x >= 2 ** z || y >= 2 ** z) { res.writeHead(400); return res.end("Invalid tile coordinates."); }
      return await handleTile(req, res, z, x, y);
    }
    if (req.method !== "GET") { res.writeHead(405); return res.end("Method not allowed"); }
    let filePath = url.pathname === "/" ? path.join(ROOT, "index.html") : path.join(ROOT, decodeURIComponent(url.pathname));
    if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end("Forbidden"); }
    fs.stat(filePath, (err, st) => {
      if (err || !st.isFile()) {
        // SPA fallback to index
        filePath = path.join(ROOT, "index.html");
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600" });
      fs.createReadStream(filePath).pipe(res);
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: "Server error: " + err.message });
  }
});
server.listen(PORT, () => console.log("Maps Grid Rank Tracker listening on " + PORT));
