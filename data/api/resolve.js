const fs = require("fs");
const path = require("path");

const C_BASE_URL = process.env.C_BASE_URL || "";
const IMDB_ID = "tt0388629"; // One Piece

let cache = {
  time: 0,
  episodeToEntry: null
};

const TTL_MS = 5 * 60 * 1000; // 5 minutes

function parseSeasonEpisodeFromFilename(filename) {
  // Accepts patterns like: S01E02, S1E2, S01 E02, S1 E2 (case-insensitive)
  const m = String(filename).match(/S(\d{1,2})\s*E(\d{1,2})/i);
  if (!m) return null;

  const season = parseInt(m[1], 10);
  const episode = parseInt(m[2], 10);
  if (!Number.isFinite(season) || !Number.isFinite(episode)) return null;

  return { season, episode };
}

function loadListArray() {
  const filePath = path.join(process.cwd(), "data", "list.json");
  const raw = fs.readFileSync(filePath, "utf8");
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) throw new Error("data/list.json must be a JSON array");
  return arr;
}

function buildEpisodeEntryMapFromList(listArr) {
  // episodeId -> { url, filename }
  const out = {};

  for (const row of listArr) {
    const filename = row && row.filename ? String(row.filename) : "";
    const url = row && row.url ? String(row.url) : "";
    if (!filename || !url) continue;

    const se = parseSeasonEpisodeFromFilename(filename);
    if (!se) continue;

    const episodeId = `${IMDB_ID}:${se.season}:${se.episode}`;
    out[episodeId] = { url, filename };
  }

  return out;
}

async function callCResolve(inputUrl) {
  let base = String(C_BASE_URL || "").trim();
  if (!base) throw new Error("Missing C_BASE_URL");
  if (!base.startsWith("http://") && !base.startsWith("https://")) base = "https://" + base;

  const u = new URL("/api/resolve", base);
  u.searchParams.set("url", inputUrl);

  const r = await fetch(u.toString(), { method: "GET" });
  const text = await r.text();
  return { status: r.status, text };
}

async function getEpisodeToEntryMap() {
  if (cache.episodeToEntry && Date.now() - cache.time < TTL_MS) {
    return cache.episodeToEntry;
  }

  const listArr = loadListArray();
  const map = buildEpisodeEntryMapFromList(listArr);

  cache = { time: Date.now(), episodeToEntry: map };
  return map;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.end("Method Not Allowed");
      return;
    }

    const directUrl = String(req.query.url || "").trim();
    const episode = String(req.query.episode || "").trim();

    if (!directUrl && !episode) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Missing url or episode parameter" }));
      return;
    }

    let inputUrl = directUrl;
    let filename = "";

    if (!inputUrl && episode) {
      const map = await getEpisodeToEntryMap();
      const entry = map[episode];

      if (!entry || !entry.url) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Unknown episode", episode }));
        return;
      }

      inputUrl = entry.url;
      filename = String(entry.filename || "");
    }

    const { status, text } = await callCResolve(inputUrl);

    // Try to attach filename to the JSON returned by C (if any)
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      // If C returned non-JSON, pass through as-is
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(text);
      return;
    }

    if (data && typeof data === "object" && filename) {
      data.filename = filename;
    }

    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(data));
  } catch (e) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        error: "Broker failed",
        detail: String(e && e.message ? e.message : e).slice(0, 1200)
      })
    );
  }
};
