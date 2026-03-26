const express = require("express");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

// CHANGE THIS TO YOUR C SERVER URL ON VERCEL
const C_BASE_URL = "https://dlp-jipi-YOUR-VERCEL.vercel.app";

function extractFileId(driveUrl) {
  const match = driveUrl.match(/open\?id=([^&]+)/);
  if (!match) return null;
  return match[1];
}

function loadList() {
  const filePath = path.join(__dirname, "data", "list.json");
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

app.post("/resolve", async (req, res) => {
  const episodeId = req.body.episode;
  if (!episodeId) {
    return res.status(400).json({ error: "Missing episode" });
  }

  const list = loadList();
  const driveUrl = list[episodeId];

  if (!driveUrl) {
    return res.status(404).json({
      error: "Unknown episode",
      episode: episodeId
    });
  }

  const fileId = extractFileId(driveUrl);
  if (!fileId) {
    return res.status(500).json({
      error: "Bad Drive URL",
      url: driveUrl
    });
  }

  try {
    const cUrl = `${C_BASE_URL}/resolve?id=${fileId}`;
    const response = await fetch(cUrl);
    const data = await response.json();

    return res.json(data);
  } catch (e) {
    return res.status(500).json({
      error: "Broker failed",
      detail: e.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("B server running on port " + PORT);
});
