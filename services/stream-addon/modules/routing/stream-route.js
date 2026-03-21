const { createDClient } = require("../integrations/d-client");
const defaultStreamPayloads = require("../presentation/stream-payloads");

function resolveEpisodeResolver(injected = {}) {
  if (typeof injected.resolveEpisode === "function") {
    return injected.resolveEpisode;
  }

  const dClient = createDClient({
    baseUrl: injected.dBaseUrl,
    fetchImpl: injected.fetchImpl,
    executeBoundedDependency: injected.executeBoundedDependency
  });
  return dClient.resolveEpisode.bind(dClient);
}

function resolveForwardUserAgent(injected = {}) {
  if (typeof injected.forwardUserAgent === "function") {
    return injected.forwardUserAgent;
  }

  const dClient = createDClient({
    baseUrl: injected.dBaseUrl,
    fetchImpl: injected.fetchImpl,
    executeBoundedDependency: injected.executeBoundedDependency
  });
  return dClient.forwardUserAgent.bind(dClient);
}

async function handleStreamRequest(input = {}, injected = {}) {
  const req = input.req;
  const res = input.res;
  const pathname = String(input.pathname || "");
  const ip = String(input.ip || "");

  const match = pathname.match(/^\/stream\/([^/]+)\/([^/]+)\.json$/);
  if (!match || match[1] !== "series") {
    return { handled: false };
  }

  const episodeId = decodeURIComponent(match[2]);
  const isSupportedEpisode = injected.isSupportedEpisode || ((id) => id.startsWith("tt0388629"));
  if (!isSupportedEpisode(episodeId)) {
    return { handled: false };
  }

  const streamPayloads = injected.streamPayloads || defaultStreamPayloads;
  const sendDegradedStream = injected.sendDegradedStream || streamPayloads.sendDegradedStream;

  const requestUserAgent = String(req && req.headers && req.headers["user-agent"] || "");
  const streamInjected = {
    ...injected,
    requestUserAgent,
    requestRoute: pathname,
    requestStartedAt: Date.now(),
    correlationId: req && req.headers && (req.headers["x-correlation-id"] || req.headers["X-Correlation-Id"]) || ""
  };

  try {
    if (typeof injected.sendJson !== "function") {
      throw new Error("handleStreamRequest requires injected.sendJson");
    }

    const resolveEpisode = resolveEpisodeResolver(streamInjected);
    const resolved = await resolveEpisode(episodeId);
    const finalUrl = typeof resolved.url === "string"
      ? resolved.url.replace(/^http:\/\//, "https://")
      : "";

    if (!finalUrl.startsWith("https://")) {
      sendDegradedStream(req, res, "validation_invalid_stream_url", injected);
      return {
        handled: true,
        outcome: {
          source: "validation",
          cause: "validation_invalid_stream_url",
          result: "degraded"
        }
      };
    }

    const formatStreamLocal = injected.formatStream || streamPayloads.formatStream;
    injected.sendJson(req, res, 200, {
      streams: [formatStreamLocal(resolved.title, finalUrl)]
    });

    const forwardUserAgent = resolveForwardUserAgent(streamInjected);
    Promise.resolve()
      .then(() => forwardUserAgent(requestUserAgent, episodeId, {
        onFailure: () => {}
      }))
      .catch(() => {});

    return {
      handled: true,
      outcome: {
        source: "d",
        cause: "success",
        result: "success"
      }
    };
  } catch (error) {
    sendDegradedStream(req, res, error, injected);
    const classifyFailure = injected.classifyFailure || ((value) => ({ source: "d", cause: "dependency_unavailable" }));
    const degraded = classifyFailure({ error, source: "d" });
    return {
      handled: true,
      outcome: {
        source: degraded.source,
        cause: degraded.cause,
        result: "degraded"
      }
    };
  }
}

module.exports = {
  handleStreamRequest
};
