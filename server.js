const http = require("http");
const gateway = require("./api/gateway");

const PORT = Number(process.env.PORT || 3000);

const server = http.createServer((req, res) => {
  gateway(req, res).catch((error) => {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      error: "internal_error",
      detail: String(error && error.message ? error.message : error),
    }));
  });
});

server.listen(PORT, () => {
  process.stdout.write(`hub-server listening on http://localhost:${PORT}\n`);
});
