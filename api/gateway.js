const path = require("path");
const { pathToFileURL } = require("url");

let gateHandlersPromise = null;
const cjsModuleCache = new Map();

function buildNotFound(res) {
  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error: "not_found" }));
}

function sendDependencyError(res, serviceName, error) {
  res.statusCode = 503;
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      error: "service_dependency_missing",
      service: serviceName,
      detail: String(error && error.message ? error.message : error),
    })
  );
}

function loadCjsModule(modulePath) {
  if (cjsModuleCache.has(modulePath)) {
    return cjsModuleCache.get(modulePath);
  }

  try {
    const loaded = require(modulePath);
    cjsModuleCache.set(modulePath, loaded);
    return loaded;
  } catch (error) {
    const wrapped = { __loadError: error };
    cjsModuleCache.set(modulePath, wrapped);
    return wrapped;
  }
}

function attachExpressLikeResponse(res) {
  if (typeof res.status !== "function") {
    res.status = (statusCode) => {
      res.statusCode = Number(statusCode) || 200;
      return res;
    };
  }

  if (typeof res.json !== "function") {
    res.json = (payload) => {
      if (!res.getHeader("Content-Type")) {
        res.setHeader("Content-Type", "application/json");
      }
      res.end(JSON.stringify(payload));
      return res;
    };
  }

  return res;
}

function parseIncoming(req) {
  const reqUrl = new URL(req.url || "/", "http://localhost");
  const routeRaw = String(reqUrl.searchParams.get("route") || "").trim();
  const routePath = `/${routeRaw.replace(/^\/+/, "")}`;
  const params = new URLSearchParams(reqUrl.searchParams);
  params.delete("route");

  return {
    pathname: routePath === "/" ? "/" : routePath,
    searchParams: params,
  };
}

function parseQueryFromParams(searchParams) {
  const query = {};
  for (const [key, value] of searchParams.entries()) {
    if (Object.prototype.hasOwnProperty.call(query, key)) {
      if (Array.isArray(query[key])) {
        query[key].push(value);
      } else {
        query[key] = [query[key], value];
      }
    } else {
      query[key] = value;
    }
  }
  return query;
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

async function enhanceReq(req, fullPathname, searchParams, prefix) {
  const subPath = fullPathname.startsWith(prefix)
    ? fullPathname.slice(prefix.length) || "/"
    : fullPathname;

  req.originalUrl = req.url;
  req.url = `${subPath}${searchParams.toString() ? `?${searchParams.toString()}` : ""}`;
  req.query = parseQueryFromParams(searchParams);

  const method = String(req.method || "GET").toUpperCase();
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    const contentType = String(req.headers["content-type"] || "").toLowerCase();
    if (contentType.includes("application/json") && (typeof req.body === "undefined" || req.body === null)) {
      try {
        req.body = await readJsonBody(req);
      } catch {
        req.body = {};
      }
    }
  }

  return subPath;
}

async function loadGateHandlers() {
  if (!gateHandlersPromise) {
    gateHandlersPromise = (async () => {
      const resolveUrl = pathToFileURL(path.join(__dirname, "..", "..", "link-gate", "api", "resolve.js")).href;
      const indexUrl = pathToFileURL(path.join(__dirname, "..", "..", "link-gate", "api", "index.js")).href;
      const healthUrl = pathToFileURL(path.join(__dirname, "..", "..", "link-gate", "api", "health.js")).href;

      const [resolveModule, indexModule, healthModule] = await Promise.all([
        import(resolveUrl),
        import(indexUrl),
        import(healthUrl),
      ]);

      return {
        resolve: resolveModule.default,
        index: indexModule.default,
        health: healthModule.default,
      };
    })();
  }

  return gateHandlersPromise;
}

async function routeBroker(req, res, pathname, searchParams) {
  const brokerIndexHandler = loadCjsModule("../../link-broker/api/index");
  const brokerResolveHandler = loadCjsModule("../../link-broker/api/resolve");
  const brokerHealthHandler = loadCjsModule("../../link-broker/api/health");
  const brokerLoadError =
    brokerIndexHandler.__loadError ||
    brokerResolveHandler.__loadError ||
    brokerHealthHandler.__loadError;

  if (brokerLoadError) {
    sendDependencyError(res, "link-broker", brokerLoadError);
    return;
  }

  const subPath = await enhanceReq(req, pathname, searchParams, "/broker");
  if (subPath === "/" || subPath === "/api" || subPath === "/api/index") {
    await brokerIndexHandler(req, res);
    return;
  }
  if (subPath === "/api/resolve") {
    await brokerResolveHandler(req, res);
    return;
  }
  if (subPath === "/api/health") {
    await brokerHealthHandler(req, res);
    return;
  }
  buildNotFound(res);
}

async function routeGate(req, res, pathname, searchParams) {
  const subPath = await enhanceReq(req, pathname, searchParams, "/gate");
  let gate;
  try {
    gate = await loadGateHandlers();
  } catch (error) {
    sendDependencyError(res, "link-gate", error);
    return;
  }

  if (subPath === "/" || subPath === "/api" || subPath === "/api/index") {
    await gate.index(req, res);
    return;
  }
  if (subPath === "/api/resolve") {
    await gate.resolve(req, res);
    return;
  }
  if (subPath === "/api/health") {
    await gate.health(req, res);
    return;
  }
  buildNotFound(res);
}

async function routeWorker(req, res, pathname, searchParams) {
  const workerHandler = loadCjsModule("../../link-worker/api/resolve");
  if (workerHandler.__loadError) {
    sendDependencyError(res, "link-worker", workerHandler.__loadError);
    return;
  }

  await enhanceReq(req, pathname, searchParams, "/worker");
  await workerHandler(req, res);
}

async function routeStreamAddon(req, res, pathname, searchParams) {
  const streamAddonHandler = loadCjsModule("../../stream-addon/serverless");
  if (streamAddonHandler.__loadError) {
    sendDependencyError(res, "stream-addon", streamAddonHandler.__loadError);
    return;
  }

  req.originalUrl = req.url;
  req.url = `${pathname}${searchParams.toString() ? `?${searchParams.toString()}` : ""}`;
  req.query = parseQueryFromParams(searchParams);
  await streamAddonHandler(req, res);
}

module.exports = async (req, res) => {
  attachExpressLikeResponse(res);

  const { pathname, searchParams } = parseIncoming(req);

  if (pathname === "/combined/health") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: "ok", server: "nakama-hub-server" }));
    return;
  }

  try {
    if (pathname.startsWith("/broker")) {
      await routeBroker(req, res, pathname, searchParams);
      return;
    }

    if (pathname.startsWith("/gate")) {
      await routeGate(req, res, pathname, searchParams);
      return;
    }

    if (pathname.startsWith("/worker")) {
      await routeWorker(req, res, pathname, searchParams);
      return;
    }

    await routeStreamAddon(req, res, pathname, searchParams);
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        error: "internal_error",
        detail: String(error && error.message ? error.message : error),
      })
    );
  }
};
