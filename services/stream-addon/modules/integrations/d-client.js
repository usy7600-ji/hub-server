const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

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
const RESOLVE_CACHE = new Map();

function resolveBinaryPath() {
  const cwdBinary = path.join(process.cwd(), "bin", "dlp-jipi");
  if (fs.existsSync(cwdBinary)) {
    return cwdBinary;
  }

  const cwdYtDlp = path.join(process.cwd(), "bin", "yt-dlp");
  if (fs.existsSync(cwdYtDlp)) {
    return cwdYtDlp;
  }

  const serviceLocalBinary = path.join(__dirname, "..", "..", "..", "..", "..", "bin", "dlp-jipi");
  if (fs.existsSync(serviceLocalBinary)) {
    return serviceLocalBinary;
  }

  const serviceLocalYtDlp = path.join(__dirname, "..", "..", "..", "..", "..", "bin", "yt-dlp");
  if (fs.existsSync(serviceLocalYtDlp)) {
    return serviceLocalYtDlp;
  }

  throw createError("Missing resolver binary", "dependency_unavailable", 503);
}

function resolveDirectMediaUrl(inputUrl) {
  return new Promise((resolve, reject) => {
    let binaryPath;
    try {
      binaryPath = resolveBinaryPath();
    } catch (error) {
      reject(error);
      return;
    }

    execFile(
      binaryPath,
      [
        "--no-playlist",
        "--no-warnings",
        "--add-header",
        "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "-f",
        "bv*+ba/b",
        "--output",
        "hub.%(ext)s",
        "-g",
        inputUrl,
      ],
      { timeout: 57000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(createError(String(stderr || error.message || error).trim().slice(0, 1200), "dependency_unavailable", 502));
          return;
        }

        const directUrl = String(stdout || "").trim().split("\n").filter(Boolean)[0] || "";
        if (!directUrl || !/^https?:\/\//i.test(directUrl)) {
          reject(createError("Resolver returned invalid media URL", "validation_error", 502));
          return;
        }

        resolve(directUrl.replace(/^http:\/\//i, "https://"));
      }
    );
  });
}

function createDClient(options = {}) {
  async function resolveEpisode(episodeId, options = {}) {
    void options;
    const { season, episode } = parseEpisodeId(episodeId);
    const hit = EPISODE_MAP.get(`${season}:${episode}`);
    if (!hit) {
      throw createError("Episode not found in local catalog", "dependency_unavailable", 404);
    }

    const cacheKey = `${season}:${episode}`;
    const cached = RESOLVE_CACHE.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { url: cached.url, title: cached.title };
    }

    const mediaUrl = await resolveDirectMediaUrl(String(hit.url || "").trim());
    const title = String(hit.filename || `S${season} E${episode}`).trim();
    RESOLVE_CACHE.set(cacheKey, {
      url: mediaUrl,
      title,
      expiresAt: Date.now() + 30 * 60 * 1000,
    });

    return {
      url: mediaUrl,
      title,
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
