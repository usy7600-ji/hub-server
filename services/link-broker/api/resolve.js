const fs = require("fs");
const path = require("path");
const { supabase } = require("../lib/supabase");

const FIRST_WORKER_ENV = "SERVER_C1_URL";
const LAST_WORKER_ENV = "SERVER_C9_URL";
const FETCH_TIMEOUT_MS = 58_000;
const MAX_TTL_SECONDS = 86_400;
const WORKER_RR_KEY = "worker:rr";
const FAILURE_DETAIL_MAX_LEN = 500;
const NO_WORKERS_DETAIL = "WORKER_URLS is empty or not configured";
const NO_CF_WORKERS_ERROR = "cf_workers_unavailable";
const NO_CF_WORKERS_DETAIL = "Season 1-2 routing requires SERVER_C3_URL and/or SERVER_C4_URL";
const RETRYABLE_WORKER_STATUSES = new Set([429, 500, 502, 503, 504]);

let statsHour = getCurrentUtcHourIso();
let requestCount = 0;
let errorCount = 0;

const EPISODE_MAP = (() => {
  const map = new Map();
  const dataDir = path.join(__dirname, "../data");
  fs.readdirSync(dataDir)
    .filter(f => /^S\d+_/.test(f) && f.endsWith(".json"))
    .forEach(f => {
      const rows = require(path.join(dataDir, f));
      for (const row of (Array.isArray(rows) ? rows : [])) {
        if (!row || !row.filename || !row.url) continue;
        const m = String(row.filename).match(/S(\d{1,3})\s*E(\d{1,3})/i);
        if (!m) continue;
        const season = parseInt(m[1], 10);
        const episode = parseInt(m[2], 10);
        if (!Number.isFinite(season) || !Number.isFinite(episode)) continue;
        map.set(`${season}:${episode}`, { url: String(row.url), filename: String(row.filename) });
      }
    });
  return map;
})();

function createBaseLogContext() {
  return {
    episode_id: null,
    cache: "bypass",
    worker: null,
    workers_attempted: 0,
    failed_workers: [],
    duration_ms: 0,
    status: 200,
    message: null,
    error: null,
    ts: null
  };
}

function getCurrentUtcHourIso() {
  return new Date().toISOString().slice(0, 13) + ":00:00Z";
}

function rollStatsHourIfNeeded() {
  const currentHour = getCurrentUtcHourIso();
  if (statsHour !== currentHour) {
    statsHour = currentHour;
    requestCount = 0;
    errorCount = 0;
  }
}

function incrementRequestCount() {
  rollStatsHourIfNeeded();
  requestCount += 1;
}

function incrementErrorCount() {
  rollStatsHourIfNeeded();
  errorCount += 1;
}

function readResolveStatsSnapshot() {
  rollStatsHourIfNeeded();
  return {
    hour: statsHour,
    requestCount,
    errorCount
  };
}

function buildFailureMessage(error, detail) {
  const reason = String(error || "request failed").trim() || "request failed";
  const detailText = String(detail || "").trim();
  if (!detailText) {
    return `Server B could not complete the request because ${reason}.`;
  }
  return `Server B could not complete the request because ${reason}: ${detailText}`;
}

function finalizeLogContext(req, res, requestStartMs, overrides) {
  if (!req) return;
  if (!req.logContext || typeof req.logContext !== "object") {
    req.logContext = createBaseLogContext();
  }

  if (!Array.isArray(req.logContext.failed_workers)) {
    req.logContext.failed_workers = [];
  }
  if (Array.isArray(req.failedWorkerAttempts)) {
    req.logContext.failed_workers = buildFailedWorkersForLog(req.failedWorkerAttempts);
  }

  req.logContext.duration_ms = Math.max(0, Date.now() - Number(requestStartMs || Date.now()));
  req.logContext.status = Number(res && res.statusCode ? res.statusCode : 500);
  req.logContext.ts = new Date().toISOString();

  if (overrides && typeof overrides === "object") {
    Object.assign(req.logContext, overrides);
  }
}

function sendError(res, httpStatus, error, detail, req, requestStartMs) {
  const errorCode = String(error || "request_failed").trim() || "request_failed";
  const detailText = String(detail || "").slice(0, FAILURE_DETAIL_MAX_LEN);
  res.statusCode = httpStatus;
  const narrativeMessage = buildFailureMessage(errorCode, detailText).slice(0, FAILURE_DETAIL_MAX_LEN);
  if (req && req.logContext && typeof req.logContext === "object") {
    req.logContext.message = narrativeMessage;
  }
  finalizeLogContext(req, res, requestStartMs, {
    event: "resolve_error",
    message: narrativeMessage,
    error: errorCode,
    detail: detailText
  });

  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({
    error: errorCode,
    detail: detailText
  }));
}

function parseEpisodeId(episodeId) {
  const parts = String(episodeId).split(":");
  if (parts.length < 3) return null;
  const imdbId = String(parts[0] || "").trim();
  if (!imdbId) return null;
  const season = parseInt(parts[1], 10);
  const episode = parseInt(parts[2], 10);
  if (!Number.isFinite(season) || !Number.isFinite(episode)) return null;
  return { imdbId, season, episode };
}

function normalizeSuccessPayload(payload, fallbackFilename) {
  const safePayload = payload && typeof payload === "object" ? payload : {};
  const resolvedUrl = String(safePayload.url || safePayload.streamUrl || safePayload.link || "").trim();
  const resolvedFilename = String(safePayload.filename || fallbackFilename || "").trim();
  return {
    ...safePayload,
    ...(resolvedUrl && { url: resolvedUrl }),
    ...(resolvedFilename && { filename: resolvedFilename })
  };
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  if (req && typeof req.body === "object" && req.body !== null && !Buffer.isBuffer(req.body)) {
    return req.body;
  }

  if (typeof req.body === "string") {
    if (!req.body.trim()) return {};
    return JSON.parse(req.body);
  }

  if (Buffer.isBuffer(req.body)) {
    const rawBody = req.body.toString("utf8");
    if (!rawBody.trim()) return {};
    return JSON.parse(rawBody);
  }

  const rawBody = await readRequestBody(req);
  if (!rawBody.trim()) return {};
  return JSON.parse(rawBody);
}

async function normalizeResolveInput(req) {
  const directUrl = String(req.query.url || "").trim();
  const noCache = String(req.query.nocache || "").toLowerCase() === "true";

  if (req.method !== "POST") {
    return {
      directUrl,
      episode: String(req.query.episode || "").trim(),
      noCache,
      transport: "query"
    };
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return { error: "Invalid JSON body", detail: "POST /api/resolve expects JSON { imdb_id, season, episode }" };
  }

  const imdbId = String(body && body.imdb_id || "").trim();
  const season = parseInt(String(body && body.season || ""), 10);
  const episode = parseInt(String(body && body.episode || ""), 10);

  if (!imdbId || !Number.isFinite(season) || !Number.isFinite(episode)) {
    return { error: "Missing required fields", detail: "Provide JSON body { imdb_id, season, episode }" };
  }

  return {
    directUrl,
    episode: `${imdbId}:${season}:${episode}`,
    noCache,
    transport: "post"
  };
}

async function callCResolve(inputUrl, req, options) {
  const passthroughNon200 = !!(options && options.passthroughNon200);
  const workers = Array.isArray(options && options.workers) && options.workers.length > 0
    ? options.workers
    : getConfiguredWorkers();
  const workerSlots = Array.isArray(options && options.workerSlots) ? options.workerSlots : null;
  if (workers.length === 0) throw new Error(NO_WORKERS_DETAIL);
  const startIndex = await readWorkerCursor(req);
  const safeStartIndex = Number.isInteger(startIndex) && startIndex >= 0 ? startIndex : 0;
  const selectedIndex = safeStartIndex % workers.length;
  const nextIndex = (selectedIndex + 1) % workers.length;
  const attemptOrder = buildAttemptOrder(workers.length, selectedIndex);
  if (req && req.logContext) {
    req.logContext.workerCursorStart = safeStartIndex;
    req.logContext.workerSelectedIndex = selectedIndex;
    req.logContext.workerCursorNext = nextIndex;
    req.logContext.workerAttemptOrder = attemptOrder;
  }
  await writeWorkerCursor(nextIndex, req);

  let lastError = "All workers failed";
  let attemptNumber = 0;
  for (const workerIndex of attemptOrder) {
    attemptNumber += 1;
    const workerSlot = Number.isInteger(workerSlots && workerSlots[workerIndex])
      ? workerSlots[workerIndex]
      : workerIndex;
    const base = normalizeWorkerBase(workers[workerIndex]);
    const u = new URL("/api/resolve", base);
    u.searchParams.set("url", inputUrl);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const r = await fetch(u.toString(), {
        method: "GET",
        signal: controller.signal,
      });
        const text = await r.text();
        if (r.status !== 200) {
          if (passthroughNon200) {
            if (RETRYABLE_WORKER_STATUSES.has(r.status)) {
              lastError = `worker[${workerSlot}] status ${r.status}: ${text.slice(0, 200)}`;
              recordFailedWorkerAttempt(req, workerSlot, base, attemptNumber, lastError);
              continue;
            }
            let non200Data;
            try {
              non200Data = JSON.parse(text);
            } catch {
              lastError = `worker[${workerSlot}] status ${r.status}: ${text.slice(0, 200)}`;
              recordFailedWorkerAttempt(req, workerSlot, base, attemptNumber, lastError);
              continue;
            }
            if (req && req.logContext) req.logContext.worker = workerSlot;
            return { status: r.status, data: non200Data };
          }
          lastError = `worker[${workerSlot}] status ${r.status}: ${text.slice(0, 200)}`;
          recordFailedWorkerAttempt(req, workerSlot, base, attemptNumber, lastError);
          continue;
        }

      let data;
        try {
          data = JSON.parse(text);
        } catch {
          lastError = `worker[${workerSlot}] invalid JSON`;
          recordFailedWorkerAttempt(req, workerSlot, base, attemptNumber, lastError);
          continue;
        }

        if (req && req.logContext) req.logContext.worker = workerSlot;
        return { status: 200, data };
      } catch (e) {
        if (e && e.name === "AbortError") {
          lastError = `worker[${workerSlot}] timeout after ${FETCH_TIMEOUT_MS}ms`;
        } else {
          lastError = `worker[${workerSlot}] request failed: ${e.message}`;
        }
        recordFailedWorkerAttempt(req, workerSlot, base, attemptNumber, lastError);
      } finally {
        clearTimeout(timeout);
        if (req && req.logContext) {
        req.logContext.workers_attempted = (req.logContext.workers_attempted || 0) + 1;
      }
    }
  }

  const allWorkersFailedError = new Error(lastError);
  allWorkersFailedError.isAllWorkersFailed = true;
  throw allWorkersFailedError;
}

function getCloudflareWorkers() {
  const workers = [];
  const c3 = String(process.env.SERVER_C3_URL || "").trim();
  if (c3) {
    workers.push({ slot: 2, url: c3 });
  }

  const c4 = String(process.env.SERVER_C4_URL || "").trim();
  if (c4) {
    workers.push({ slot: 3, url: c4 });
  }

  return workers;
}

function classifyFailureType(errorDetail) {
  const detail = String(errorDetail || "").toLowerCase();
  if (detail.includes("timeout")) return "timeout";
  if (detail.includes("status")) return "bad-status";
  if (detail.includes("invalid json")) return "invalid-json";
  return "network-error";
}

function buildFailedWorkersForLog(rows) {
  return rows.map((row) => ({
    worker_id: row.worker_id,
    error: row.error_type
  }));
}

function recordFailedWorkerAttempt(req, workerId, workerUrl, attempt, errorDetail) {
  if (!req || !Number.isInteger(workerId) || workerId < 0) return;
  const episodeId = String(req.failureEpisodeId || "").trim();
  if (!episodeId) return;
  const detail = String(errorDetail || "").slice(0, FAILURE_DETAIL_MAX_LEN);

  const row = {
    episode_id: episodeId,
    worker_id: workerId,
    error_type: classifyFailureType(errorDetail),
    detail,
    worker_url: String(workerUrl || "").slice(0, FAILURE_DETAIL_MAX_LEN),
    attempt: Number.isInteger(attempt) && attempt > 0 ? attempt : null,
    error: detail
  };

  if (!Array.isArray(req.failedWorkerAttempts)) {
    req.failedWorkerAttempts = [];
  }
  req.failedWorkerAttempts.push(row);

  if (req.logContext) {
    req.logContext.failed_workers = buildFailedWorkersForLog(req.failedWorkerAttempts);
  }
}

function enqueueFailedWorkerTelemetry(req) {
  if (!req || !Array.isArray(req.failedWorkerAttempts) || req.failedWorkerAttempts.length === 0) {
    return;
  }

  const rows = req.failedWorkerAttempts.map((row) => ({ ...row }));
  const schedule = typeof queueMicrotask === "function"
    ? queueMicrotask
    : (fn) => setImmediate(fn);

  schedule(() => {
    for (const row of rows) {
      supabase.from("failures").insert(row)
        .then(({ error }) => {
          if (error) {
            console.error(JSON.stringify({
              server: "B",
              event: "failure_telemetry_insert_error",
              episode_id: row.episode_id,
              worker_id: row.worker_id,
              ts: new Date().toISOString()
            }));
          }
        })
        .catch(() => {});
    }
  });

  if (req.logContext) {
    req.logContext.failure_rows = rows.length;
  }
}

function getConfiguredWorkers() {
  const workers = [];
  for (let i = 1; i <= 9; i += 1) {
    const envKey = `SERVER_C${i}_URL`;
    const workerUrl = String(process.env[envKey] || "").trim();
    if (!workerUrl) {
      break;
    }
    workers.push(workerUrl);
  }
  return workers;
}

function normalizeWorkerBase(workerUrl) {
  let base = String(workerUrl || "").trim();
  if (!base) throw new Error("Empty worker URL");
  if (!base.startsWith("http://") && !base.startsWith("https://")) base = "https://" + base;
  return base;
}

function buildAttemptOrder(workerCount, startIndex) {
  const order = [];
  for (let i = 0; i < workerCount; i += 1) {
    order.push((startIndex + i) % workerCount);
  }
  return order;
}

async function readWorkerCursor(req) {
  try {
    const now = new Date().toISOString();
    const { data: row, error } = await supabase.from("state").select("value")
      .eq("key", WORKER_RR_KEY).gt("expires_at", now).maybeSingle();
    if (error) throw new Error(error.message);
    if (row === null || row.value === null || typeof row.value === "undefined") return 0;

    if (typeof row.value === "number" && Number.isInteger(row.value)) return row.value;
    if (typeof row.value === "string") {
      const parsedString = parseInt(row.value, 10);
      return Number.isInteger(parsedString) ? parsedString : 0;
    }
    if (typeof row.value === "object") {
      const parsedObject = parseInt(String(row.value.index || ""), 10);
      return Number.isInteger(parsedObject) ? parsedObject : 0;
    }
  } catch {
    if (req && req.logContext) req.logContext.workerCursorRead = "fallback-0";
    return 0;
  }
  return 0;
}

async function writeWorkerCursor(nextIndex, req) {
  try {
    const expiresAt = new Date(Date.now() + MAX_TTL_SECONDS * 1000).toISOString();
    const { error } = await supabase.from("state")
      .upsert({ key: WORKER_RR_KEY, value: { index: nextIndex }, expires_at: expiresAt }, { onConflict: "key" });
    if (error) throw new Error(error.message);
  } catch {
    if (req && req.logContext) req.logContext.workerCursorWrite = "failed";
  }
}

const resolveHandler = async function(req, res) {
  const requestStartMs = Date.now();
  req.logContext = createBaseLogContext();
  req.failedWorkerAttempts = [];
  req.failureEpisodeId = null;

  res.once("finish", () => {
    enqueueFailedWorkerTelemetry(req);
  });

  if (req.method !== "GET" && req.method !== "DELETE" && req.method !== "POST") {
    sendError(
      res,
      405,
      "method_not_allowed",
      "Use GET or POST to resolve, DELETE ?episode=... to clear cache",
      req,
      requestStartMs
    );
    return;
  }

  if (req.method === "POST" || String(req.query && req.query.url || "").trim() || String(req.query && req.query.episode || "").trim()) {
    incrementRequestCount();
  }

  const normalized = await normalizeResolveInput(req);
  if (normalized.error) {
    sendError(res, 400, "bad_request", normalized.detail, req, requestStartMs);
    return;
  }

  const directUrl = normalized.directUrl;
  const episode = normalized.episode;
  const noCache = normalized.noCache;

  if (req.method === "DELETE") {
    if (!episode) {
      sendError(res, 400, "bad_request", "Provide ?episode=imdb:season:ep", req, requestStartMs);
      return;
    }

    const parsed = parseEpisodeId(episode);
    if (!parsed) {
      sendError(res, 400, "bad_request", `Cannot parse: ${episode}`, req, requestStartMs);
      return;
    }

    Object.assign(req.logContext, {
      episode_id: episode,
      cache: "bypass",
      worker: null,
      error: null
    });

    try {
      const { error } = await supabase.from("fixed_links")
        .delete()
        .eq("imdb_id", parsed.imdbId)
        .eq("season", parsed.season)
        .eq("episode", parsed.episode);
      if (error) throw new Error(error.message);
      res.statusCode = 200;
      finalizeLogContext(req, res, requestStartMs, { error: null });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ status: "ok", cleared: episode }));
    } catch (e) {
      sendError(res, 502, "cache_clear_failed", e.message, req, requestStartMs);
    }
    return;
  }

  if (req.method === "GET" && !directUrl && !episode) {
    Object.assign(req.logContext, {
      cache: "bypass",
      worker: null,
      error: null
    });
    res.statusCode = 200;
    finalizeLogContext(req, res, requestStartMs, { error: null });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end([
      "<h1>Broker (B) is alive.</h1>",
      "<h2>Endpoint reference</h2><pre>",
      "POST   /api/resolve  { imdb_id, season, episode }      resolve episode (contract path)",
      "GET    /api/resolve?episode=imdb:season:ep            resolve episode (fixed_links fast path)",
      "GET    /api/resolve?episode=imdb:season:ep&nocache=true  bypass fixed_links fast path, force fresh fetch",
      "GET    /api/resolve?url=&lt;drive-url&gt;                    direct proxy to Server C (no cache)",
      "DELETE /api/resolve?episode=imdb:season:ep            clear fixed_links entry for one episode",
      "</pre>",
    ].join("\n"));
    return;
  }

  if (directUrl) {
    const workers = getConfiguredWorkers();
    Object.assign(req.logContext, {
      cache: "bypass",
      worker: null,
      error: null
    });

    if (workers.length === 0) {
      sendError(res, 500, "no_workers", NO_WORKERS_DETAIL, req, requestStartMs);
      return;
    }

    try {
      const { status, data } = await callCResolve(directUrl, req, { passthroughNon200: true });
      res.statusCode = status;
      finalizeLogContext(req, res, requestStartMs, { error: null });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(data));
    } catch (e) {
      if (e && e.isAllWorkersFailed) {
        incrementErrorCount();
      }
      sendError(res, 502, "upstream_failed", e.message, req, requestStartMs);
    }
    return;
  }

  try {
    const parsed = parseEpisodeId(episode);
    if (!parsed) {
      sendError(res, 400, "bad_request", `Cannot parse episode ID: ${episode}`, req, requestStartMs);
      return;
    }

    req.failureEpisodeId = episode;
    Object.assign(req.logContext, {
      episode_id: episode,
      cache: noCache ? "bypass" : "miss",
      worker: null,
      error: null
    });

    const { imdbId, season, episode: ep } = parsed;
    let selectedWorkers = getConfiguredWorkers();
    let selectedWorkerSlots = null;

    if (season === 1 || season === 2) {
      const cloudflareWorkers = getCloudflareWorkers();
      if (cloudflareWorkers.length === 0) {
        sendError(res, 503, NO_CF_WORKERS_ERROR, NO_CF_WORKERS_DETAIL, req, requestStartMs);
        return;
      }
      selectedWorkers = cloudflareWorkers.map((worker) => worker.url);
      selectedWorkerSlots = cloudflareWorkers.map((worker) => worker.slot);
    }

    if (selectedWorkers.length === 0) {
      sendError(res, 500, "no_workers", NO_WORKERS_DETAIL, req, requestStartMs);
      return;
    }

    if (!noCache) {
      const { data: fixedRow, error: fixedErr } = await supabase
        .from("fixed_links")
        .select("fixed_link, filename")
        .eq("imdb_id", imdbId)
        .eq("season", season)
        .eq("episode", ep)
        .maybeSingle();

      if (fixedErr) throw new Error(fixedErr.message);

      if (fixedRow !== null) {
        const fixedData = normalizeSuccessPayload({
          url: fixedRow.fixed_link,
          filename: fixedRow.filename
        });

        if (fixedData.url && fixedData.filename) {
          req.logContext.cache = "hit";
          res.statusCode = 200;
          finalizeLogContext(req, res, requestStartMs, { error: null });
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ...fixedData, cache: "hit" }));
          return;
        }
      }
    }

    let { data: epRow, error: epErr } = await supabase
      .from("episodes").select("url, filename")
      .eq("imdb_id", imdbId).eq("season", season).eq("episode", ep).maybeSingle();
    if (epErr) throw new Error(epErr.message);

    if (epRow === null) {
      const local = EPISODE_MAP.get(`${season}:${ep}`);
      if (!local) {
        sendError(res, 404, "unknown_episode", `No data for ${episode}`, req, requestStartMs);
        return;
      }

      const { error: upsertErr } = await supabase.from("episodes")
        .upsert({ imdb_id: imdbId, season, episode: ep, url: local.url, filename: local.filename },
                 { onConflict: "imdb_id,season,episode" });
      if (upsertErr) req.logContext.lazySeedError = upsertErr.message;
      epRow = local;
    }

    const { data } = await callCResolve(epRow.url, req, {
      workers: selectedWorkers,
      workerSlots: selectedWorkerSlots
    });
    const payload = normalizeSuccessPayload(data, epRow && epRow.filename);
    if (!payload.url) {
      throw new Error("Invalid worker response: missing url");
    }
    if (!payload.filename) {
      throw new Error("Invalid worker response: missing filename");
    }

    const { error: cacheWriteErr } = await supabase.from("fixed_links")
      .upsert(
        {
          imdb_id: imdbId,
          season,
          episode: ep,
          fixed_link: payload.url,
          filename: payload.filename
        },
        { onConflict: "imdb_id,season,episode" }
      );
    if (cacheWriteErr) req.logContext.cacheWriteError = cacheWriteErr.message;

    payload.cache = noCache ? "bypass" : "miss";
    req.logContext.cache = payload.cache;

    res.statusCode = 200;
    finalizeLogContext(req, res, requestStartMs, { error: null });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(payload));
  } catch (e) {
    if (e && e.isAllWorkersFailed) {
      incrementErrorCount();
    }
    const errorDetail = String(e && e.message || "Unknown error");
    sendError(res, 502, "upstream_failed", errorDetail, req, requestStartMs);
  }
};

module.exports = resolveHandler;
module.exports.readStatsSnapshot = readResolveStatsSnapshot;
