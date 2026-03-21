function renderHomePage(host) {
  const safeHost = String(host || "").replace(/[^a-zA-Z0-9.:-]/g, "").trim();
  const installUrl = safeHost ? `stremio://${safeHost}/manifest.json` : "stremio:///manifest.json";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Stream Hub</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { min-height: 100vh; display: grid; place-items: center; background: radial-gradient(circle at 20% 10%, #1f1f1f, #0c0c0c 45%); color: #e6e6e6; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; padding: 20px; }
    .card { width: min(100%, 580px); border: 1px solid #2a2a2a; border-radius: 14px; background: linear-gradient(180deg, #121212, #0f0f0f); box-shadow: 0 20px 50px #00000066; padding: 28px; }
    h1 { font-size: 1.35rem; letter-spacing: 0.06em; margin-bottom: 10px; }
    p { color: #a8a8a8; margin-bottom: 16px; }
    .btn { display: inline-block; border: 1px solid #3e3e3e; border-radius: 10px; padding: 10px 14px; color: #fff; text-decoration: none; }
    .btn:hover { border-color: #676767; }
  </style>
</head>
<body>
  <main class="card">
    <h1>Stream Hub</h1>
    <p>Unified Stremio addon server.</p>
    <a class="btn" href="${installUrl}">Install Addon</a>
  </main>
</body>
</html>`;
}

module.exports = {
  renderHomePage,
};
