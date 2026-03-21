const { supabase } = require("../lib/supabase");

const FIRST_WORKER_ENV = "SERVER_C1_URL";
const LAST_WORKER_ENV = "SERVER_C9_URL";
const CHECK_ENDPOINT = "/api/index?check=1";

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

async function checkSupabase() {
  try {
    const { error } = await supabase.from("fixed_links").select("imdb_id").limit(1);
    if (error) {
      return { ok: false, error: String(error.message || error).slice(0, 200) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e).slice(0, 200) };
  }
}

async function checkWorker(url) {
  if (!url) {
    return { ok: false, error: "worker URL not configured" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const healthUrl = new URL("/health", url).toString();
    const response = await fetch(healthUrl, { method: "GET", signal: controller.signal });
    const bodyText = await response.text();
    let body;
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = null;
    }

    if (!response.ok) {
      return {
        ok: false,
        error: String((body && (body.error || body.detail)) || `status ${response.status}`).slice(0, 200)
      };
    }

    return {
      ok: true,
      workerId: body && body.worker_id ? String(body.worker_id) : "unknown"
    };
  } catch (e) {
    if (e && e.name === "AbortError") {
      return { ok: false, error: "health timeout after 5000ms" };
    }
    return { ok: false, error: String(e && e.message ? e.message : e).slice(0, 200) };
  } finally {
    clearTimeout(timeout);
  }
}

function getConfiguredWorkers() {
  const workers = [];
  for (let i = 1; i <= 9; i += 1) {
    const envKey = `SERVER_C${i}_URL`;
    const workerUrl = String(process.env[envKey] || "").trim();
    if (!workerUrl) break;
    workers.push({ name: `C${i}`, envKey, url: workerUrl });
  }
  return workers;
}

function getQueryParam(req, key) {
  try {
    const url = new URL(String(req.url || "/"), "http://localhost");
    return String(url.searchParams.get(key) || "");
  } catch {
    return "";
  }
}

async function runChecks({ envOk, envError, configuredWorkers }) {
  const supabaseResult = envOk
    ? await checkSupabase()
    : { ok: false, error: envError || "env not configured" };

  const workers = await Promise.all(
    configuredWorkers.map(async (worker) => {
      const startedAt = Date.now();
      const result = await checkWorker(worker.url);
      return {
        name: worker.name,
        envKey: worker.envKey,
        ok: Boolean(result.ok),
        ms: Math.max(0, Date.now() - startedAt),
        error: result.ok ? "" : String(result.error || "down").slice(0, 200),
        workerId: result.workerId ? String(result.workerId) : ""
      };
    })
  );

  return { supabase: supabaseResult, workers };
}

function renderPage(state) {
  const color = state.envOk
    ? (state.ranChecks ? (state.allOk ? "#00ff5a" : "#ff4444") : "#ffaa00")
    : "#ff8800";
  const label = state.envOk
    ? (state.ranChecks ? (state.allOk ? "ONLINE" : "DEGRADED") : "READY")
    : "ENV ERROR";

  const workerSummary = state.configuredWorkers.length > 0
    ? `${state.configuredWorkers.length} configured (${state.configuredWorkers.map((w) => w.name).join(", ")})`
    : `none configured (${FIRST_WORKER_ENV}..${LAST_WORKER_ENV})`;

  const checks = [
    { label: "Env vars", ok: state.envOk, error: state.envError },
    {
      label: "Supabase",
      ok: state.ranChecks ? state.supabase.ok : null,
      error: state.ranChecks ? state.supabase.error : "Press Check to run"
    },
    {
      label: "Worker scan",
      ok: state.ranChecks
        ? (state.workerChecks.length > 0 && state.workerChecks.every((row) => row.result.ok))
        : null,
      error: state.ranChecks ? workerSummary : "Press Check to run"
    }
  ];

  const statusText = (row) => {
    if (row.ok === null) return '<span class="warn">\u25CB idle</span>';
    if (row.ok) return '<span class="ok">\u2713 ok</span>';
    return `<span class="err">\u2717 ${escapeHtml(row.error || "error")}</span>`;
  };

  const checksHtml = checks.map((row) => `
    <div class="row">
      <span class="label">${escapeHtml(row.label)}</span>
      ${statusText(row)}
    </div>`).join("");

  const urls = [
    { label: FIRST_WORKER_ENV, value: state.firstWorkerUrl },
    { label: LAST_WORKER_ENV, value: state.lastWorkerUrl },
    { label: "SUPABASE_URL", value: state.supabaseUrl }
  ];

  const urlsHtml = urls.map((row) => `
    <div class="row">
      <span class="label">${escapeHtml(row.label)}</span>
      <span class="${row.value ? "ok" : "warn"}">${row.value ? "\u2713 " + escapeHtml(maskUrl(row.value)) : "\u26A0 not set"}</span>
    </div>`).join("");

  const workersHtml = state.configuredWorkers.length === 0
    ? `
      <div class="row">
        <span class="label">Workers</span>
        <span class="warn">\u26A0 ${escapeHtml(workerSummary)}</span>
      </div>`
    : state.configuredWorkers.map((worker) => {
      const checkedRow = state.workerChecks.find((row) => row.worker.name === worker.name);
      const result = checkedRow ? checkedRow.result : null;
      const status = !state.ranChecks
        ? '<span class="warn">\u25CB idle</span>'
        : result && result.ok
          ? `<span class="ok">\u2713 up (${Number(result.ms || 0)}ms)</span>`
          : `<span class="err">\u2717 ${escapeHtml((result && result.error) || "down")}</span>`;
      return `
        <div class="row">
          <span class="label">${escapeHtml(worker.name)} /health</span>
          <span id="worker-status-${escapeHtml(worker.name)}" class="worker-status">${status}</span>
        </div>`;
    }).join("");

  const workerList = state.configuredWorkers.map((worker) => ({ name: worker.name }));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Server B - Status</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0a0a0a; color: #ccc; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
    .card { border: 1px solid ${color}44; padding: 32px; border-radius: 12px; box-shadow: 0 0 30px ${color}12; max-width: 520px; width: 100%; }
    .header { display: flex; align-items: center; gap: 12px; margin-bottom: 28px; }
    .dot { width: 12px; height: 12px; border-radius: 50%; background: ${color}; box-shadow: 0 0 10px ${color}; flex-shrink: 0; }
    .title { font-size: 1.15rem; color: ${color}; letter-spacing: 1px; font-weight: bold; }
    .subtitle { font-size: 0.75rem; color: #444; margin-top: 3px; }
    .row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 9px 0; border-bottom: 1px solid #141414; font-size: 0.85rem; }
    .row:last-child { border-bottom: none; }
    .label { color: #555; }
    .ok { color: #00ff5a; }
    .warn { color: #ffaa00; }
    .err { color: #ff4444; word-break: break-all; text-align: right; max-width: 300px; }
    .val { color: #ddd; }
    .section-header { color: #444; font-size: 0.75rem; letter-spacing: 1px; text-transform: uppercase; padding: 14px 0 6px; border-bottom: 1px solid #1a1a1a; }
    .check-form { margin-top: 14px; margin-bottom: 4px; }
    .check-btn { width: 100%; border: 1px solid #333; border-radius: 8px; background: #0f0f0f; color: #ddd; padding: 10px 14px; cursor: pointer; font-family: inherit; font-size: 0.8rem; letter-spacing: 0.4px; text-transform: uppercase; }
    .check-btn:hover { border-color: #555; color: #fff; }
    .check-btn:disabled { opacity: 0.75; cursor: wait; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="dot"></div>
      <div>
        <div class="title">SERVER B - ${label}</div>
        <div class="subtitle">Broker - Vercel Serverless</div>
      </div>
    </div>

    <div class="section-header">Health Checks</div>
    ${checksHtml}

    <div class="section-header">Worker Health</div>
    ${workersHtml}

    <div class="check-form">
      <button id="check-btn" type="button" class="check-btn">Check Workers</button>
    </div>

    <div class="section-header">Connections</div>
    ${urlsHtml}

    <div class="section-header">Endpoints</div>
    <div class="row"><span class="label">Resolve</span><span class="val">GET/POST /api/resolve</span></div>
    <div class="row"><span class="label">Health</span><span class="val">GET /api/health</span></div>
    <div class="row"><span class="label">Workers configured</span><span class="val">${escapeHtml(String(state.configuredWorkers.length))}</span></div>
  </div>
  <script>
    (() => {
      const endpoint = ${JSON.stringify(CHECK_ENDPOINT)};
      const workers = ${JSON.stringify(workerList)};
      const button = document.getElementById("check-btn");

      if (!button || workers.length === 0) {
        if (button && workers.length === 0) {
          button.disabled = true;
          button.textContent = "No Workers Configured";
        }
        return;
      }

      const setStatus = (workerName, symbol, cls, text) => {
        const el = document.getElementById("worker-status-" + workerName);
        if (!el) return;
        el.className = "worker-status " + cls;
        el.textContent = symbol + " " + text;
      };

      button.addEventListener("click", async () => {
        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = "Checking...";

        workers.forEach((worker) => {
          setStatus(worker.name, "\u25CB", "warn", "checking...");
        });

        try {
          const response = await fetch(endpoint, { method: "GET" });
          const payload = await response.json();
          const resultMap = new Map(Array.isArray(payload.workers)
            ? payload.workers.map((row) => [String(row.name), row])
            : []);

          workers.forEach((worker) => {
            const row = resultMap.get(worker.name);
            if (!row) {
              setStatus(worker.name, "\u2717", "err", "no response");
              return;
            }
            if (row.ok) {
              setStatus(worker.name, "\u2713", "ok", "up (" + Number(row.ms || 0) + "ms)");
              return;
            }
            setStatus(worker.name, "\u2717", "err", String(row.error || "down"));
          });
        } catch (error) {
          const reason = String(error && error.message ? error.message : error).slice(0, 200);
          workers.forEach((worker) => {
            setStatus(worker.name, "\u2717", "err", reason || "request failed");
          });
        } finally {
          button.disabled = false;
          button.textContent = originalText;
        }
      });
    })();
  </script>
</body>
</html>`;
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Method Not Allowed", detail: "Use GET" }));
    return;
  }

  const checkFlag = getQueryParam(req, "check");
  const isCheckRequest = checkFlag === "1";
  const supabaseUrl = String(process.env.SUPABASE_URL || "").trim();
  const serviceRole = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const configuredWorkers = getConfiguredWorkers();
  const firstWorkerUrl = String(process.env[FIRST_WORKER_ENV] || "").trim();
  const lastWorkerUrl = String(process.env[LAST_WORKER_ENV] || "").trim();

  const missingEnv = [];
  if (!supabaseUrl) missingEnv.push("SUPABASE_URL");
  if (!serviceRole) missingEnv.push("SUPABASE_SERVICE_ROLE_KEY");

  const envOk = missingEnv.length === 0;
  const envError = envOk ? "" : `Missing: ${missingEnv.join(", ")}`;

  if (isCheckRequest) {
    const checks = await runChecks({ envOk, envError, configuredWorkers });
    const workersOk = checks.workers.length > 0 && checks.workers.every((row) => row.ok);
    const allOk = envOk && checks.supabase.ok && workersOk;

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({
      ok: allOk,
      status: allOk ? "ok" : "degraded",
      envOk,
      envError,
      supabase: checks.supabase,
      workers: checks.workers,
      checkedAt: new Date().toISOString()
    }));
    return;
  }

  const html = renderPage({
    allOk: false,
    ranChecks: false,
    envOk,
    envError,
    supabase: { ok: false, error: "Press Check to run" },
    workerChecks: [],
    configuredWorkers,
    firstWorkerUrl,
    lastWorkerUrl,
    supabaseUrl
  });

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
};
