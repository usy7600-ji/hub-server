const { addonBuilder } = require("stremio-addon-sdk");
const { createDClient } = require("./modules/integrations/d-client");

const IMDB_ID = "tt0388629";

const manifest = {
  id: "org.nakama.streamhub",
  version: "1.0.0",
  name: "Nakama Stream Hub",
  description: "Community stream addon",
  logo: "https://images.metahub.space/logo/medium/tt0388629/img",
  background: "https://images.metahub.space/background/medium/tt0388629/img",
  resources: ["catalog", "stream"],
  types: ["series"],
  catalogs: [{ type: "series", id: "anime_hub_catalog", name: "Nakama Catalog" }],
  idPrefixes: [IMDB_ID]
};

const builder = new addonBuilder(manifest);
const dClient = createDClient();

builder.defineCatalogHandler(async (args) => {
  if (args.type !== "series" || args.id !== "anime_hub_catalog") {
    return { metas: [] };
  }

  return {
    metas: [
      {
        id: "tt0388629",
        type: "series",
        name: "Nakama Series",
        poster: "https://images.metahub.space/poster/medium/tt0388629/img"
      }
    ]
  };
});

async function resolveEpisode(episodeId) {
  return dClient.resolveEpisode(episodeId);
}

builder.defineStreamHandler(async (args) => {
  if (args.type !== "series") {
    return { streams: [] };
  }

  const streamId = String(args.id || "");
  if (!streamId.startsWith(IMDB_ID)) {
    return { streams: [] };
  }

  try {
    const resolved = await resolveEpisode(streamId);

    return {
      streams: [
        {
          name: "Nakama Hub",
          title: resolved.title,
          url: resolved.url,
          behaviorHints: { notWebReady: false }
        }
      ]
    };
  } catch {
    return { streams: [] };
  }
});

const addonInterface = builder.getInterface();
addonInterface.resolveEpisode = resolveEpisode;

module.exports = addonInterface;
