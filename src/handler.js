const { getRouter } = require("stremio-addon-sdk");
const { addonInterface, manifest } = require("./lib/addon");
const { resolveEpisode } = require("./lib/resolver");
const { renderHomePage } = require("./lib/pages");

const stremioRouter = getRouter(addonInterface);

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function getPathname(req) {
  try {
    return new URL(req.url || "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

async function handleResolveApi(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed", detail: "Use GET" });
    return;
  }

  const reqUrl = new URL(req.url || "/", "http://localhost");
  const episodeId = String(reqUrl.searchParams.get("episodeId") || "").trim();
  if (!episodeId) {
    sendJson(res, 400, { error: "bad_request", detail: "Missing episodeId query" });
    return;
  }

  try {
    const resolved = await resolveEpisode(episodeId);
    sendJson(res, 200, resolved);
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    const code = message === "episode_not_found" ? 404 : 502;
    sendJson(res, code, { error: "resolve_failed", detail: message });
  }
}

async function handler(req, res) {
  const pathname = getPathname(req);

  if (pathname === "/") {
    const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").trim();
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(renderHomePage(host));
    return;
  }

  if (pathname === "/health" || pathname === "/combined/health") {
    sendJson(res, 200, { status: "ok", service: "stream-hub", manifest: manifest.id });
    return;
  }

  if (pathname === "/api/resolve") {
    await handleResolveApi(req, res);
    return;
  }

  stremioRouter(req, res, () => {
    sendJson(res, 404, { error: "not_found" });
  });
}

module.exports = {
  handler,
};
