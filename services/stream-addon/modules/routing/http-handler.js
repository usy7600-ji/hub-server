const { getRouter } = require("stremio-addon-sdk");
const proxyaddr = require("proxy-addr");
const { handleStreamRequest } = require("./stream-route");
const { sendDegradedStream } = require("../presentation/stream-payloads");
const {
  renderLandingPage,
  projectPublicHealth
} = require("../presentation/public-pages");

function toHourBucket(options = {}) {
  const nowMs = Number(options.nowMs || Date.now());
  const now = new Date(nowMs);
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const hour = String(now.getUTCHours()).padStart(2, "0");
  return `${year}-${month}-${day}-${hour}`;
}

function parsePositiveIntEnv(name, fallback) {
  const raw = process.env[name];
  const parsed = Number.parseInt(String(raw || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseBooleanEnv(name, fallback) {
  const raw = String(process.env[name] || "").trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return fallback;
}

const TEST_VIDEO_URL = "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/1080/Big_Buck_Bunny_1080_10s_1MB.mp4";

const DEFAULT_TRUST_PROXY = "loopback,linklocal,uniquelocal";
const DEFAULT_CORS_HEADERS = "Content-Type,Authorization";
const DEFAULT_CORS_METHODS = "GET,OPTIONS";

const DEGRADED_STREAM_POLICY = Object.freeze({
  capacity_busy: {
    mode: "fallback",
    message: "Temporary load. Try again in a few minutes."
  },
  dependency_timeout: {
    mode: "fallback",
    message: "Stream source is temporarily delayed. Please retry shortly."
  },
  dependency_unavailable: {
    mode: "fallback",
    message: "Stream source is temporarily unavailable. Please retry shortly."
  }
});

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getTrustedProxy() {
  const trustValue = process.env.TRUST_PROXY || DEFAULT_TRUST_PROXY;
  const trustList = parseCsv(trustValue);
  return proxyaddr.compile(trustList.length ? trustList : ["loopback"]);
}

function getTrustedClientIp(req) {
  try {
    const proxyReq = req.connection ? req : { ...req, connection: req.socket };
    const trusted = proxyaddr(proxyReq, getTrustedProxy());
    return trusted || "unknown";
  } catch {
    return (req.socket && req.socket.remoteAddress) || (req.connection && req.connection.remoteAddress) || "unknown";
  }
}

function isStremioRoute(pathname) {
  return pathname === "/manifest.json" || pathname.startsWith("/catalog/") || pathname.startsWith("/stream/");
}

function isGatedStreamRoute(pathname) {
  return pathname.startsWith("/stream/");
}

function parseStreamEpisodeId(pathname) {
  const match = String(pathname || "").match(/^\/stream\/series\/([^/]+)\.json$/);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return "";
  }
}

function classifyRoute(pathname) {
  if (isStremioRoute(pathname)) {
    return "stremio";
  }
  return "public";
}

function getCorsPolicy() {
  const origins = new Set(parseCsv(process.env.CORS_ALLOW_ORIGINS));
  const headers = parseCsv(process.env.CORS_ALLOW_HEADERS || DEFAULT_CORS_HEADERS).map((item) => item.toLowerCase());
  const methods = parseCsv(process.env.CORS_ALLOW_METHODS || DEFAULT_CORS_METHODS);

  return {
    origins,
    headers,
    methods
  };
}

function getRequestPathname(req) {
  try {
    return new URL(req.url || "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

function applyCors(req, res, pathnameInput) {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
  const pathname = String(pathnameInput || getRequestPathname(req));
  if (!origin) {
    return { hasOrigin: false, originAllowed: false };
  }

  const policy = getCorsPolicy();
  const allowStremioRoute = isStremioRoute(pathname);
  if (!allowStremioRoute && !policy.origins.has(origin)) {
    return { hasOrigin: true, originAllowed: false };
  }

  const accessControlOrigin = allowStremioRoute ? "*" : origin;
  res.setHeader("Access-Control-Allow-Origin", accessControlOrigin);
  const vary = String(res.getHeader ? res.getHeader("Vary") || "" : "");
  if (accessControlOrigin !== "*") {
    const varyEntries = parseCsv(vary).map((item) => item.toLowerCase());
    if (!varyEntries.includes("origin")) {
      const nextVary = vary ? `${vary}, Origin` : "Origin";
      res.setHeader("Vary", nextVary);
    }
  }
  return { hasOrigin: true, originAllowed: true, policy };
}

function sendJson(req, res, statusCode, payload) {
  applyCors(req, res);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function handlePreflight(req, res) {
  if (req.method !== "OPTIONS") return false;

  const pathname = getRequestPathname(req);
  const cors = applyCors(req, res, pathname);
  if (!cors.originAllowed) {
    res.statusCode = 204;
    res.end();
    return true;
  }

  const requestedMethod = String(req.headers["access-control-request-method"] || "").trim().toUpperCase();
  if (requestedMethod && !cors.policy.methods.includes(requestedMethod)) {
    sendJson(req, res, 403, {
      error: "cors_method_not_allowed",
      detail: "Requested method is not allowed by CORS policy."
    });
    return true;
  }

  const requestedHeaders = parseCsv(req.headers["access-control-request-headers"]).map((item) => item.toLowerCase());
  const invalidHeader = requestedHeaders.find((header) => !cors.policy.headers.includes(header));
  if (invalidHeader) {
    sendJson(req, res, 403, {
      error: "cors_header_not_allowed",
      detail: "Requested headers are not allowed by CORS policy."
    });
    return true;
  }

  res.setHeader("Access-Control-Allow-Methods", cors.policy.methods.join(","));
  res.setHeader("Access-Control-Allow-Headers", cors.policy.headers.join(","));
  res.statusCode = 204;
  res.end();
  return true;
}

function sendPublicError(req, res, statusCode = 503) {
  sendJson(req, res, statusCode, {
    error: "service_unavailable",
    detail: "Service temporarily unavailable."
  });
}

function handlePublicRoute(req, res, pathname) {
  if (pathname === "/") {
    const host = String(req.headers["x-forwarded-host"] || req.headers.host || "")
      .trim()
      .replace(/[^a-zA-Z0-9.:-]/g, "");
    const installUrl = host
      ? `stremio://${host}/manifest.json`
      : "stremio:///manifest.json";

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html");
    applyCors(req, res);
    res.end(renderLandingPage({ installUrl }));
    return { handled: true, outcome: { source: "policy", cause: "success", result: "success" } };
  }

  if (pathname === "/health") {
    sendJson(req, res, 200, projectPublicHealth());
    return { handled: true, outcome: { source: "policy", cause: "success", result: "success" } };
  }

  return { handled: false };
}

function toCount(value) {
  const parsed = Number.parseInt(String(value == null ? "0" : value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

let statsBucket = toHourBucket();
let statsRequestCount = 0;
let statsErrorCount = 0;

function rollStatsBucketIfNeeded() {
  const nextBucket = toHourBucket();
  if (nextBucket !== statsBucket) {
    statsBucket = nextBucket;
    statsRequestCount = 0;
    statsErrorCount = 0;
  }
}

function markStatsRequest() {
  rollStatsBucketIfNeeded();
  statsRequestCount += 1;
}

function markStatsError(statusCode) {
  rollStatsBucketIfNeeded();
  const numericStatus = Number(statusCode || 0);
  if (numericStatus >= 400) {
    statsErrorCount += 1;
  }
}

function normalizeReliabilityResult(statusCode, fallbackResult = "success") {
  const numericStatus = Number(statusCode || 0);
  if (numericStatus >= 500) return "failure";
  if (numericStatus >= 400) return "failure";
  return fallbackResult;
}

function buildStreamRouteDependencies() {
  return {
    resolveEpisode: (...args) => getAddonInterface().resolveEpisode(...args),
    sendJson,
    sendDegradedStream,
    degradedPolicy: DEGRADED_STREAM_POLICY,
    fallbackVideoUrl: TEST_VIDEO_URL
  };
}

function getAddonInterface() {
  return require("../../addon");
}

async function createHttpHandler(req, res) {
  const runtimeRouter = getRouter(getAddonInterface());
  const streamRouteDependencies = buildStreamRouteDependencies();

  const startedAt = Date.now();
  const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = reqUrl.pathname;
  const shouldTrackStats = pathname !== "/api/stats" && String(req.method || "GET").toUpperCase() !== "OPTIONS";
  if (shouldTrackStats) {
    markStatsRequest();
  }

  try {
    if (handlePreflight(req, res)) {
      return;
    }

    const publicResult = handlePublicRoute(req, res, pathname);
    if (publicResult.handled) {
      return;
    }

    try {
      const controlResult = { allowed: true, ip: getTrustedClientIp(req) };

      if (pathname.startsWith("/stream/")) {
        const streamResult = await handleStreamRequest(
          {
            req,
            res,
            pathname,
            ip: controlResult.ip || getTrustedClientIp(req)
          },
          streamRouteDependencies
        );
        if (streamResult && streamResult.handled) {
          return;
        }
      }
    } catch (error) {
      if (pathname.startsWith("/stream/")) {
        sendDegradedStream(req, res, error, streamRouteDependencies);
        return;
      }
      sendPublicError(req, res, 503);
      return;
    }

    applyCors(req, res);
    runtimeRouter(req, res, () => {
      res.statusCode = 404;
      res.end();
    });
  } finally {
    if (shouldTrackStats) {
      markStatsError(res.statusCode);
    }
  }
}

module.exports = {
  createHttpHandler
};
