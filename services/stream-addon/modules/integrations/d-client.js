const DEFAULT_ATTEMPT_TIMEOUT_MS = 65000;
const DEFAULT_TOTAL_TIMEOUT_MS = 200000;
const DEFAULT_RETRY_JITTER_MS = 150;
const { executeBoundedDependency } = require("./bounded-dependency");

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function createError(message, code, statusCode) {
  const err = new Error(message);
  err.code = code;
  if (typeof statusCode === "number") {
    err.statusCode = statusCode;
  }
  return err;
}

function validateResolveResponse(payload) {
  if (!payload || typeof payload !== "object") {
    throw createError("D returned invalid payload", "validation_error");
  }

  const resolvedUrl = typeof payload.url === "string" ? payload.url.trim() : "";
  const resolvedFilename = typeof payload.filename === "string" ? payload.filename.trim() : "";

  if (!resolvedUrl || !resolvedUrl.startsWith("https://")) {
    throw createError("D returned invalid url", "validation_error");
  }
  if (!resolvedFilename) {
    throw createError("D returned invalid filename", "validation_error");
  }

  return {
    url: resolvedUrl,
    title: resolvedFilename
  };
}

function normalizeClientIp(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  return normalized;
}

function validateErrorEnvelope(payload, statusCode) {
  if (!payload || typeof payload !== "object") {
    throw createError("D returned invalid error payload", "validation_error", statusCode);
  }

  const error = typeof payload.error === "string" ? payload.error.trim() : "";
  const detail = typeof payload.detail === "string" ? payload.detail.trim() : "";
  if (!error || !detail) {
    throw createError("D returned invalid error payload", "validation_error", statusCode);
  }

  return { error, detail };
}

async function parseErrorEnvelope(response) {
  const statusCode = Number(response && response.status) || undefined;
  try {
    const payload = await response.json();
    return validateErrorEnvelope(payload, statusCode);
  } catch (error) {
    if (error && error.code === "validation_error") {
      throw error;
    }
    throw createError("D returned non-JSON error response", "validation_error", statusCode);
  }
}

function mapDownstreamError(envelope = {}, statusCode) {
  if (envelope.error === "dependency_timeout") {
    throw createError(`D dependency timeout: ${envelope.detail}`, "dependency_timeout", statusCode);
  }
  if (envelope.error === "validation_error") {
    throw createError(`D validation failed: ${envelope.detail}`, "validation_error", statusCode);
  }
  throw createError(`D dependency unavailable: ${envelope.detail}`, "dependency_unavailable", statusCode);
}

function createDClient(options = {}) {
  const env = options.env || process.env;
  const baseUrl = String(options.baseUrl || env.D_BASE_URL || "");
  const fetchImpl = options.fetchImpl || fetch;
  const boundedDependency = options.executeBoundedDependency || executeBoundedDependency;
  const attemptTimeoutMs = parsePositiveInteger(options.attemptTimeoutMs || env.D_ATTEMPT_TIMEOUT_MS, DEFAULT_ATTEMPT_TIMEOUT_MS);
  const totalBudgetMs = parsePositiveInteger(options.totalBudgetMs || env.D_TOTAL_TIMEOUT_MS, DEFAULT_TOTAL_TIMEOUT_MS);
  const jitterMs = parsePositiveInteger(options.jitterMs || env.D_RETRY_JITTER_MS, DEFAULT_RETRY_JITTER_MS);

  async function resolveEpisode(episodeId, options = {}) {
    const id = String(episodeId || "").trim();
    if (!id) {
      throw new Error("Missing episode id");
    }
    if (!baseUrl) {
      throw createError("Missing D_BASE_URL", "dependency_unavailable");
    }

    const resolveUrl = new URL("/api/resolve", baseUrl).toString();

    const clientIp = normalizeClientIp(options.clientIp);
    let response;
    try {
      response = await boundedDependency(async ({ timeout }) => {
        const headers = {
          "content-type": "application/json"
        };
        if (clientIp) {
          headers["x-client-ip"] = clientIp;
        }

        const nextResponse = await fetchImpl(resolveUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({ episodeId: id }),
          signal: AbortSignal.timeout(timeout)
        });

        if (!nextResponse.ok) {
          const envelope = await parseErrorEnvelope(nextResponse);
          mapDownstreamError(envelope, nextResponse.status);
        }

        return nextResponse;
      }, {
        attemptTimeoutMs,
        totalBudgetMs,
        jitterMs,
        maxAttempts: 3
      });
    } catch (error) {
      if (error && (error.code === "dependency_timeout" || error.code === "validation_error" || error.code === "dependency_unavailable")) {
        throw error;
      }

      throw createError(
        "D dependency unavailable",
        "dependency_unavailable",
        Number(error && error.statusCode) || undefined
      );
    }

    let data;
    try {
      data = await response.json();
    } catch {
      throw createError("D returned non-JSON response", "validation_error");
    }

    return validateResolveResponse(data);
  }

  function forwardUserAgent(userAgent, episodeId, { onFailure, clientIp } = {}) {
    if (!baseUrl) return;

    const uaUrl = new URL("/api/ua", baseUrl).toString();

    Promise.resolve()
      .then(() => {
        const headers = {
          "content-type": "application/json"
        };
        const normalizedIp = normalizeClientIp(clientIp);
        if (normalizedIp) {
          headers["x-client-ip"] = normalizedIp;
        }

        return fetchImpl(uaUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({
            userAgent: String(userAgent || ""),
            episodeId: String(episodeId || ""),
            timestamp: new Date().toISOString()
          })
        });
      })
      .catch((error) => {
        if (typeof onFailure === "function") {
          try {
            onFailure(error);
          } catch {
          }
        }
      });
  }

  return {
    resolveEpisode,
    forwardUserAgent
  };
}

module.exports = {
  createDClient
};
