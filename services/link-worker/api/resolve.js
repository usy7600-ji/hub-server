const { execFile } = require("child_process");
const { randomUUID } = require("crypto");
const path = require("path");

const BINARY = path.join(process.cwd(), "bin", "dlp-jipi");
const WORKER_ID = process.env.WORKER_ID || "worker";
const TURSO_DATABASE_URL = String(process.env.TURSO_DATABASE_URL || "").trim();
const TURSO_AUTH_TOKEN = String(process.env.TURSO_AUTH_TOKEN || "").trim();

const COLD_START = Date.now();

let totalRequests   = 0;
let errorCount      = 0;
let totalDurationMs = 0;

let statsHour = null;
let statsHourRequestBaseline = 0;
let statsHourErrorBaseline = 0;

let lastResolve     = null;

let resolveState     = "idle";

let selfTestCache  = null;
let selfTestExpiry = 0;

let hourlyDbClient = null;
let hourlyDbInitPromise = null;
let hourlyDbInitErrorLogged = false;

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function maskUrl(url) {
  if (!url) return "-";
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return String(url).slice(0, 30) + "...";
  }
}

function sendJsonError(res, statusCode, error, detail, extraHeaders = {}) {
  res.statusCode = statusCode;
  for (const [headerName, headerValue] of Object.entries(extraHeaders)) {
    res.setHeader(headerName, headerValue);
  }
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error, detail }));
}

function logRequestError({ event, error, detail, correlationId, requestId, method, path }) {
  console.error(JSON.stringify({
    server: "C",
    event,
    error,
    detail,
    correlationId,
    requestId,
    method,
    path,
    worker_id: WORKER_ID,
    ts: new Date().toISOString(),
  }));
}

function sendLoggedJsonError({
  res,
  statusCode,
  event,
  error,
  detail,
  responseDetail,
  correlationId,
  requestId,
  method,
  path,
  allow,
}) {
  logRequestError({
    event,
    error,
    detail,
    correlationId,
    requestId,
    method,
    path,
  });
  sendJsonError(res, statusCode, error, responseDetail || detail, allow ? { Allow: allow } : undefined);
}

function getResolveValidationFailure({ method, inputUrl }) {
  if (method !== "GET") {
    return {
      statusCode: 405,
      event: "method_not_allowed",
      error: "method_not_allowed",
      detail: `Only GET is allowed for /api/resolve; received ${method}.`,
      responseDetail: "Only GET is allowed for /api/resolve.",
      allow: "GET",
    };
  }

  if (!inputUrl) {
    return {
      statusCode: 400,
      event: "missing_url_param",
      error: "missing_url_parameter",
      detail: "The url query parameter is required.",
    };
  }

  if (!isHttpUrl(inputUrl)) {
    return {
      statusCode: 400,
      event: "invalid_url",
      error: "invalid_url",
      detail: `Expected http(s) URL; received ${inputUrl.slice(0, 120)}.`,
      responseDetail: "The url query parameter must be a valid http(s) URL.",
    };
  }

  return null;
}

async function checkServerB(serverBUrl) {
  if (!serverBUrl) {
    return { ok: false, ms: 0, error: "SERVER_B_URL not set" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const startedAt = Date.now();
  try {
    const healthUrl = new URL("/api/health", serverBUrl).toString();
    const response = await fetch(healthUrl, { method: "GET", signal: controller.signal });
    if (!response.ok) {
      return {
        ok: false,
        ms: Date.now() - startedAt,
        error: `status ${response.status}`
      };
    }
    return { ok: true, ms: Date.now() - startedAt };
  } catch (e) {
    if (e && e.name === "AbortError") {
      return { ok: false, ms: Date.now() - startedAt, error: "health timeout after 5000ms" };
    }
    return {
      ok: false,
      ms: Date.now() - startedAt,
      error: String(e && e.message ? e.message : e).slice(0, 200)
    };
  } finally {
    clearTimeout(timeout);
  }
}

function runYtDlp(inputUrl) {
  return new Promise((resolve, reject) => {
    execFile(
      BINARY,
      [
        "--no-playlist",
        "--no-warnings",
        "--add-header",
        "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "-f", "bv*+ba/b",
        "--output", "jipi.%(ext)s",
        "-g",
        inputUrl,
      ],
      { timeout: 57000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(String(stderr || err.message || err).trim().slice(0, 1200)));
          return;
        }
        const url = String(stdout).trim().split("\n").filter(Boolean)[0] || "";
        resolve(url);
      }
    );
  });
}

function runSelfTest() {
  return new Promise((resolve) => {
    execFile(BINARY, ["--version"], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve({ ok: false, error: String(err?.message || err).trim() });
      } else {
        resolve({ ok: true, version: stdout.trim() });
      }
    });
  });
}

async function runSelfTestCached() {
  if (selfTestCache && Date.now() < selfTestExpiry) return selfTestCache;
  const result = await runSelfTest();
  selfTestCache = result;
  selfTestExpiry = Date.now() + 30_000;
  return result;
}

function formatUptime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s since cold start`;
  if (m > 0) return `${m}m ${s}s since cold start`;
  return `${s}s since cold start`;
}

function getCurrentUtcHourIso() {
  return `${new Date().toISOString().slice(0, 13)}:00:00Z`;
}

async function getHourlyDbClient() {
  if (!TURSO_DATABASE_URL) {
    return null;
  }

  if (hourlyDbClient) {
    return hourlyDbClient;
  }

  if (hourlyDbInitPromise) {
    return hourlyDbInitPromise;
  }

  hourlyDbInitPromise = (async () => {
    try {
      const { createClient } = require("@libsql/client");
      const client = createClient({
        url: TURSO_DATABASE_URL,
        authToken: TURSO_AUTH_TOKEN || undefined,
      });

      await client.execute(`
        create table if not exists hourly_records (
          server text not null,
          hour text not null,
          request_count integer not null default 0 check (request_count >= 0),
          error_count integer not null default 0 check (error_count >= 0),
          primary key (server, hour)
        )
      `);

      await client.execute(
        "create index if not exists idx_hourly_records_server_hour on hourly_records(server, hour)"
      );

      hourlyDbClient = client;
      return hourlyDbClient;
    } catch (error) {
      if (!hourlyDbInitErrorLogged) {
        hourlyDbInitErrorLogged = true;
        console.error(JSON.stringify({
          server: "C",
          ts: new Date().toISOString(),
          event: "turso_init_failed",
          detail: String(error && error.message ? error.message : error).slice(0, 300),
          worker_id: WORKER_ID,
        }));
      }

      return null;
    } finally {
      hourlyDbInitPromise = null;
    }
  })();

  return hourlyDbInitPromise;
}

function toNonNegativeInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return 0;
  }
  return Math.floor(numeric);
}

async function incrementHourlyRecord(requestDelta, errorDelta) {
  const client = await getHourlyDbClient();
  if (!client) {
    return;
  }

  const hour = getCurrentUtcHourIso();

  try {
    await client.execute({
      sql: `
        insert into hourly_records (server, hour, request_count, error_count)
        values ('C', ?, ?, ?)
        on conflict(server, hour) do update set
          request_count = request_count + ?,
          error_count = error_count + ?
      `,
      args: [hour, requestDelta, errorDelta, requestDelta, errorDelta],
    });
  } catch (error) {
    console.error(JSON.stringify({
      server: "C",
      ts: new Date().toISOString(),
      event: "turso_upsert_failed",
      detail: String(error && error.message ? error.message : error).slice(0, 300),
      worker_id: WORKER_ID,
    }));
  }
}

async function readCurrentHourStatsFromDb() {
  const client = await getHourlyDbClient();
  if (!client) {
    return null;
  }

  const hour = getCurrentUtcHourIso();

  try {
    const result = await client.execute({
      sql: `
        select request_count, error_count
        from hourly_records
        where server = 'C' and hour = ?
        limit 1
      `,
      args: [hour],
    });

    const row = Array.isArray(result.rows) && result.rows.length > 0 ? result.rows[0] : null;

    return {
      hour,
      requestCount: toNonNegativeInteger(row && row.request_count),
      errorCount: toNonNegativeInteger(row && row.error_count),
    };
  } catch (error) {
    console.error(JSON.stringify({
      server: "C",
      ts: new Date().toISOString(),
      event: "turso_read_failed",
      detail: String(error && error.message ? error.message : error).slice(0, 300),
      worker_id: WORKER_ID,
    }));
    return null;
  }
}

function getCurrentHourStatsFromMemory() {
  const hour = getCurrentUtcHourIso();

  if (statsHour !== hour) {
    statsHour = hour;
    statsHourRequestBaseline = totalRequests;
    statsHourErrorBaseline = errorCount;

    return {
      hour,
      requestCount: 0,
      errorCount: 0,
    };
  }

  return {
    hour,
    requestCount: Math.max(0, totalRequests - statsHourRequestBaseline),
    errorCount: Math.max(0, errorCount - statsHourErrorBaseline),
  };
}

async function getCurrentHourStats() {
  const dbStats = await readCurrentHourStatsFromDb();
  if (dbStats) {
    return dbStats;
  }

  return getCurrentHourStatsFromMemory();
}

function renderStatusPage(test) {
  const color = test.ok ? "#00ff5a" : "#ff8800";
  const label = test.ok ? "ONLINE" : "BINARY ERROR";

  const region = process.env.VERCEL_REGION || "unknown";
  const serverBUrl = String(process.env.SERVER_B_URL || "").trim();

  const uptime = formatUptime(Date.now() - COLD_START);
  const avgMs = totalRequests > 0 ? Math.round(totalDurationMs / totalRequests) : null;
  const lastResolveText = lastResolve
    ? `${lastResolve.ok ? "success" : "failed"} @ ${lastResolve.timestamp}`
    : "-";

  const ytDlpValue = test.ok
    ? `ok (${escapeHtml(test.version || "unknown")})`
    : `✗ ${escapeHtml(String(test.error || "binary check failed").slice(0, 200))}`;
  const ytDlpClass = test.ok ? "ok" : "err";

  const primaryHost = String(process.env.VERCEL_URL || "").trim();
  const baseUrl = primaryHost ? `https://${primaryHost}` : "https://example-worker-c.vercel.app";
  const sampleInputUrl = "https://example.com/sample-video.mp4";
  const curlSnippet = `curl -G --data-urlencode \"url=${sampleInputUrl}\" \"${baseUrl}/api/resolve\"`;
  const curlSnippetHtml = `
    <div class="section-header">Resolve Quick Check</div>
    <div class="row"><span class="label">Command</span><span class="val">curl /api/resolve</span></div>
    <div class="error-box" style="background:#060b12;border-color:#3a6ea530;">
      <div class="error-label" style="color:#8dbdff;">COPYABLE CURL SNIPPET</div>
      <div class="error-text" style="color:#b8d4ff;">${escapeHtml(curlSnippet)}</div>
    </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${WORKER_ID} — Status</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0a0a0a; color: #ccc; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
    .card { border: 1px solid ${color}44; padding: 32px; border-radius: 12px; box-shadow: 0 0 30px ${color}12; max-width: 560px; width: 100%; }
    .header { display: flex; align-items: center; gap: 12px; margin-bottom: 28px; }
    .dot { width: 12px; height: 12px; border-radius: 50%; background: ${color}; box-shadow: 0 0 10px ${color}; flex-shrink: 0; }
    .title { font-size: 1.15rem; color: ${color}; letter-spacing: 1px; font-weight: bold; }
    .subtitle { font-size: 0.75rem; color: #444; margin-top: 3px; }
    .row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 9px 0; border-bottom: 1px solid #141414; font-size: 0.85rem; }
    .row:last-child { border-bottom: none; }
    .label { color: #555; }
    .val { color: #ddd; }
    .ok { color: #00ff5a; }
    .warn { color: #ffaa00; }
    .err { color: #ff4444; text-align: right; max-width: 300px; word-break: break-all; }
    .pending { color: #ffaa00; }
    .error-box { margin-top: 20px; background: #120000; border: 1px solid #ff444430; border-radius: 8px; padding: 14px; }
    .error-label { color: #ff4444; font-size: 0.78rem; font-weight: bold; margin-bottom: 8px; }
    .error-text { font-size: 0.78rem; color: #ff8888; line-height: 1.6; word-break: break-all; white-space: pre-wrap; }
    .section-header { color: #444; font-size: 0.75rem; letter-spacing: 1px; text-transform: uppercase; padding: 14px 0 6px; border-bottom: 1px solid #1a1a1a; }
    .actions { margin-top: 12px; margin-bottom: 8px; }
    button { background: #111; color: #ddd; border: 1px solid #2a2a2a; border-radius: 8px; padding: 8px 14px; font-family: inherit; font-size: 0.82rem; cursor: pointer; }
    button:hover { border-color: #444; color: #fff; }
    button:disabled { opacity: 0.75; cursor: not-allowed; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="dot"></div>
      <div>
        <div class="title">SERVER C — ${label}</div>
        <div class="subtitle">yt-dlp worker · Vercel Serverless · ${escapeHtml(WORKER_ID)}</div>
      </div>
    </div>

    <div class="section-header">Health Checks</div>
    <div class="row"><span class="label">yt-dlp binary</span><span class="${ytDlpClass}">${ytDlpValue}</span></div>
    <div class="row"><span class="label">Server B /api/health</span><span id="server-b-check" class="warn">Press Check to run</span></div>
    <div class="actions">
      <button id="check-server-b" type="button">Check</button>
    </div>

    <div class="section-header">Runtime Stats</div>
    <div class="row"><span class="label">Worker ID</span><span class="val">${escapeHtml(WORKER_ID)}</span></div>
    <div class="row"><span class="label">Region</span><span class="val">${escapeHtml(region)}</span></div>
    <div class="row"><span class="label">Uptime</span><span class="val">${escapeHtml(uptime)}</span></div>
    <div class="row"><span class="label">totalRequests</span><span class="val">${totalRequests}</span></div>
    <div class="row"><span class="label">errorCount</span><span class="val">${errorCount}</span></div>
    <div class="row"><span class="label">resolveState</span><span class="val">${escapeHtml(resolveState)}</span></div>
    <div class="row"><span class="label">avgResponseMs</span><span class="val">${avgMs !== null ? `${avgMs} ms` : "-"}</span></div>
    <div class="row"><span class="label">lastResolve</span><span class="val">${escapeHtml(lastResolveText)}</span></div>

    <div class="section-header">Connections</div>
    <div class="row"><span class="label">SERVER_B_URL</span><span class="${serverBUrl ? "ok" : "warn"}">${serverBUrl ? escapeHtml(maskUrl(serverBUrl)) : "not set"}</span></div>
    <div class="row"><span class="label">Resolve endpoint</span><span class="val">GET /api/resolve?url=...</span></div>
    <div class="row"><span class="label">Health endpoint</span><span class="val">GET /health</span></div>

    ${curlSnippetHtml}
  </div>
  <script>
    (function () {
      var button = document.getElementById("check-server-b");
      var output = document.getElementById("server-b-check");
      if (!button || !output) return;

      button.addEventListener("click", async function () {
        var idleText = button.textContent;
        button.disabled = true;
        button.textContent = "Checking...";
        output.className = "pending";
        output.textContent = "○ checking...";

        try {
          var response = await fetch("/?check=1", {
            method: "GET",
            headers: { "Accept": "application/json" }
          });
          var payload = await response.json().catch(function () { return {}; });
          if (payload && payload.ok) {
            output.className = "ok";
            output.textContent = "✓ up (" + String(payload.ms || 0) + "ms)";
          } else {
            var reason = String((payload && payload.error) || ("status " + response.status)).slice(0, 200);
            output.className = "err";
            output.textContent = "✗ " + reason;
          }
        } catch (error) {
          output.className = "err";
          output.textContent = "✗ " + String(error && error.message ? error.message : error).slice(0, 200);
        } finally {
          button.disabled = false;
          button.textContent = idleText || "Check";
        }
      });
    })();
  </script>
</body>
</html>`;
}

async function handler(req, res) {
  const reqUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = reqUrl.pathname;
  const inputUrl = String(reqUrl.searchParams.get("url") || "").trim();
  const runServerBCheck = pathname === "/" && reqUrl.searchParams.get("check") === "1";
  const method = String(req.method || "unknown");
  const correlationId = String(req.headers["x-correlation-id"] || "").trim() || randomUUID();
  const requestId = String(req.headers["x-request-id"] || "").trim() || correlationId;

  if (pathname === "/health") {
    const test = await runSelfTestCached();
    res.statusCode = test.ok ? 200 : 503;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      status: test.ok ? "ok" : "error",
      worker_id: WORKER_ID,
      yt_dlp_version: test.version || null,
      error: test.error || null,
      region: process.env.VERCEL_REGION || null,
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  if (pathname === "/api/stats") {
    if (req.method !== "GET") {
      sendJsonError(res, 405, "method_not_allowed", "Only GET is allowed for /api/stats.", { Allow: "GET" });
      return;
    }

    const stats = await getCurrentHourStats();
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      server: "C",
      hour: stats.hour,
      request_count: stats.requestCount,
      error_count: stats.errorCount,
    }));
    return;
  }

  if (runServerBCheck && req.method === "GET") {
    const serverBUrl = String(process.env.SERVER_B_URL || "").trim();
    const checkResult = await checkServerB(serverBUrl);
    res.statusCode = checkResult.ok ? 200 : 503;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(checkResult));
    return;
  }

  if (pathname === "/" && !inputUrl) {
    const test = await runSelfTestCached();
    res.statusCode = test.ok ? 200 : 503;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(renderStatusPage(test));
    return;
  }

  if (pathname === "/resolve" || pathname === "/api/resolve" || pathname === "/") {
    const validationFailure = getResolveValidationFailure({ method, inputUrl });
    if (validationFailure) {
      sendLoggedJsonError({
        res,
        ...validationFailure,
        correlationId,
        requestId,
        method,
        path: pathname,
      });
      return;
    }

    console.log(JSON.stringify({
      correlationId,
      event: "request_received",
      worker_id: WORKER_ID,
      url: inputUrl.slice(0, 80),
    }));

    totalRequests++;
    await incrementHourlyRecord(1, 0);
    const t0 = Date.now();
    try {
      const directUrl = await runYtDlp(inputUrl);
      const durationMs = Date.now() - t0;
      totalDurationMs += durationMs;
      lastResolve = { timestamp: new Date().toISOString(), ok: true, durationMs };

      if (directUrl && directUrl.startsWith("http")) {
        if (resolveState === "degraded" || resolveState === "idle") resolveState = "working";
      }

      if (!directUrl || !directUrl.startsWith("http")) {
        errorCount++;
        await incrementHourlyRecord(0, 1);
        lastResolve = { timestamp: new Date().toISOString(), ok: false, durationMs };
        resolveState = "degraded";
        logRequestError({
          event: "yt_dlp_empty_url",
          error: "yt_dlp_empty_url",
          detail: `yt-dlp returned an empty or invalid URL for input ${inputUrl.slice(0, 120)}.`,
          correlationId,
          requestId,
          method,
          path: pathname,
        });
        res.statusCode = 502;
        sendJsonError(res, 502, "yt_dlp_empty_url", "yt-dlp returned an empty or invalid URL.");
        return;
      }

      res.statusCode = 200;
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ url: directUrl, worker_id: WORKER_ID }));
    } catch (e) {
      const durationMs = Date.now() - t0;
      totalDurationMs += durationMs;
      errorCount++;
      await incrementHourlyRecord(0, 1);
      const errText = String(e && e.message ? e.message : e).slice(0, 1200);
      lastResolve = { timestamp: new Date().toISOString(), ok: false, durationMs };
      resolveState = "degraded";

      logRequestError({
        event: "yt_dlp_failed",
        error: "yt_dlp_failed",
          detail: `${inputUrl.slice(0, 120)} | ${errText.slice(0, 300)}`,
          correlationId,
          requestId,
          method,
          path: pathname,
        });
      res.statusCode = 500;
      sendJsonError(res, 500, "yt_dlp_failed", errText);
    }
    return;
  }

  logRequestError({
    event: "route_not_found",
    error: "not_found",
    detail: `Unknown route: ${pathname}`,
    correlationId,
    requestId,
    method,
    path: pathname,
  });
  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error: "Not found", worker_id: WORKER_ID }));
}

module.exports = handler;
