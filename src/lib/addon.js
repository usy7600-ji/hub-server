const { addonBuilder } = require("stremio-addon-sdk");
const { resolveEpisode } = require("./resolver");

const SERIES_ID = "tt0388629";
const CATALOG_ID = "streamhub_catalog";

const manifest = {
  id: "org.streamhub.main",
  version: "1.0.0",
  name: "Stream Hub",
  description: "Unified community stream addon",
  logo: "https://images.metahub.space/logo/medium/tt0388629/img",
  background: "https://images.metahub.space/background/medium/tt0388629/img",
  resources: ["catalog", "stream"],
  types: ["series"],
  catalogs: [{ type: "series", id: CATALOG_ID, name: "Stream Catalog" }],
  idPrefixes: [SERIES_ID],
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async (args) => {
  if (args.type !== "series" || args.id !== CATALOG_ID) {
    return { metas: [] };
  }

  return {
    metas: [
      {
        id: SERIES_ID,
        type: "series",
        name: "Stream Hub Series",
        poster: "https://images.metahub.space/poster/medium/tt0388629/img",
      },
    ],
  };
});

builder.defineStreamHandler(async (args) => {
  if (args.type !== "series") return { streams: [] };

  const streamId = String(args.id || "");
  if (!streamId.startsWith(SERIES_ID)) return { streams: [] };

  try {
    const resolved = await resolveEpisode(streamId);
    return {
      streams: [
        {
          name: "Stream Hub",
          title: resolved.title,
          url: resolved.url,
          behaviorHints: { notWebReady: false },
        },
      ],
    };
  } catch {
    return { streams: [] };
  }
});

const addonInterface = builder.getInterface();

module.exports = {
  addonInterface,
  manifest,
};
