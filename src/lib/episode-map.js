const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(process.cwd(), "data", "episodes");

function buildEpisodeMap() {
  const map = new Map();
  let files = [];

  try {
    files = fs.readdirSync(DATA_DIR).filter((fileName) => /^S\d+_/.test(fileName) && fileName.endsWith(".json"));
  } catch {
    return map;
  }

  for (const fileName of files) {
    let rows;
    try {
      rows = JSON.parse(fs.readFileSync(path.join(DATA_DIR, fileName), "utf8"));
    } catch {
      continue;
    }

    if (!Array.isArray(rows)) continue;

    for (const row of rows) {
      const fileLabel = String(row && row.filename || "").trim();
      const sourceUrl = String(row && row.url || "").trim();
      if (!fileLabel || !sourceUrl) continue;

      const match = fileLabel.match(/S(\d{1,3})\s*E(\d{1,3})/i);
      if (!match) continue;

      const season = Number.parseInt(match[1], 10);
      const episode = Number.parseInt(match[2], 10);
      if (!Number.isFinite(season) || !Number.isFinite(episode)) continue;

      map.set(`${season}:${episode}`, {
        title: fileLabel,
        sourceUrl,
      });
    }
  }

  return map;
}

let cached = null;

function getEpisodeMap() {
  if (!cached) {
    cached = buildEpisodeMap();
  }
  return cached;
}

module.exports = {
  getEpisodeMap,
};
