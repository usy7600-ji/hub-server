const { handler } = require("../src/handler");

module.exports = async (req, res) => {
  const reqUrl = new URL(req.url || "/", "http://localhost");
  const routeParam = String(reqUrl.searchParams.get("route") || "").trim();

  if (routeParam) {
    const params = new URLSearchParams(reqUrl.searchParams);
    params.delete("route");
    req.url = `/${routeParam.replace(/^\/+/, "")}${params.toString() ? `?${params.toString()}` : ""}`;
  } else if (reqUrl.pathname === "/api/gateway") {
    req.url = "/";
  }

  await handler(req, res);
};
