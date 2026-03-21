const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { getEpisodeMap } = require("./episode-map");

const RESOLVE_CACHE = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;

function resolveBinaryPath() {
  const candidates = [
    path.join(process.cwd(), "bin", "dlp-jipi"),
    path.join(process.cwd(), "bin", "yt-dlp"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error("Resolver binary not found in bin/");
}

function toEpisodeKey(streamId) {
  const parts = String(streamId || "").split(":");
  if (parts.length < 3) throw new Error("invalid_stream_id");
  const season = Number.parseInt(parts[1], 10);
  const episode = Number.parseInt(parts[2], 10);
  if (!Number.isFinite(season) || !Number.isFinite(episode)) throw new Error("invalid_stream_id");
  return `${season}:${episode}`;
}

function runResolver(sourceUrl) {
  return new Promise((resolve, reject) => {
    const binaryPath = resolveBinaryPath();
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
        "stream.%(ext)s",
        "-g",
        sourceUrl,
      ],
      { timeout: 57000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || error.message || error).trim().slice(0, 1200)));
          return;
        }

        const directUrl = String(stdout || "").trim().split("\n").filter(Boolean)[0] || "";
        if (!/^https?:\/\//i.test(directUrl)) {
          reject(new Error("resolver_invalid_output"));
          return;
        }

        resolve(directUrl.replace(/^http:\/\//i, "https://"));
      }
    );
  });
}

async function resolveEpisode(streamId) {
  const key = toEpisodeKey(streamId);
  const cached = RESOLVE_CACHE.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { url: cached.url, title: cached.title };
  }

  const hit = getEpisodeMap().get(key);
  if (!hit) throw new Error("episode_not_found");

  const directUrl = await runResolver(hit.sourceUrl);
  const result = { url: directUrl, title: hit.title };
  RESOLVE_CACHE.set(key, { ...result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

module.exports = {
  resolveEpisode,
};
