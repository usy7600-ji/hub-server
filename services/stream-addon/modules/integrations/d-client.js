const fs = require("fs");
const path = require("path");

function createError(message, code, statusCode) {
  const err = new Error(message);
  err.code = code;
  if (typeof statusCode === "number") {
    err.statusCode = statusCode;
  }
  return err;
}

function buildEpisodeMap() {
  const map = new Map();
  const dataDir = path.join(__dirname, "..", "..", "..", "link-broker", "data");
  let files = [];
  try {
    files = fs.readdirSync(dataDir).filter((file) => /^S\d+_/.test(file) && file.endsWith(".json"));
  } catch {
    return map;
  }

  for (const fileName of files) {
    let rows;
    try {
      const fullPath = path.join(dataDir, fileName);
      rows = JSON.parse(fs.readFileSync(fullPath, "utf8"));
    } catch {
      continue;
    }

    if (!Array.isArray(rows)) continue;

    for (const row of rows) {
      const filename = String(row && row.filename || "").trim();
      const url = String(row && row.url || "").trim();
      if (!filename || !url) continue;

      const match = filename.match(/S(\d{1,3})\s*E(\d{1,3})/i);
      if (!match) continue;

      const season = Number.parseInt(match[1], 10);
      const episode = Number.parseInt(match[2], 10);
      if (!Number.isFinite(season) || !Number.isFinite(episode)) continue;

      map.set(`${season}:${episode}`, { url, filename });
    }
  }

  return map;
}

function parseEpisodeId(episodeId) {
  const parts = String(episodeId || "").split(":");
  if (parts.length < 3) {
    throw createError("Invalid episode id", "validation_error", 400);
  }

  const season = Number.parseInt(parts[1], 10);
  const episode = Number.parseInt(parts[2], 10);
  if (!Number.isFinite(season) || !Number.isFinite(episode)) {
    throw createError("Invalid episode id", "validation_error", 400);
  }

  return { season, episode };
}

const EPISODE_MAP = buildEpisodeMap();

function createDClient(options = {}) {
  async function resolveEpisode(episodeId, options = {}) {
    void options;
    const { season, episode } = parseEpisodeId(episodeId);
    const hit = EPISODE_MAP.get(`${season}:${episode}`);
    if (!hit) {
      throw createError("Episode not found in local catalog", "dependency_unavailable", 404);
    }

    return {
      url: String(hit.url || "").trim(),
      title: String(hit.filename || `S${season} E${episode}`).trim()
    };
  }

  function forwardUserAgent(userAgent, episodeId, { onFailure } = {}) {
    void userAgent;
    void episodeId;
    if (typeof onFailure === "function") {
      try {
        onFailure(null);
      } catch {
      }
    }
  }

  return {
    resolveEpisode,
    forwardUserAgent
  };
}

module.exports = {
  createDClient
};
