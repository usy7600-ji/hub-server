function renderLandingPage(options = {}) {
  const installUrl = String(options.installUrl || "stremio:///manifest.json");
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Nakama Stream Hub - Stremio Addon</title>
    <style>
        * { box-sizing: border-box; }
        body {
          margin: 0;
          min-height: 100dvh;
          padding: clamp(1rem, 3vw, 2rem);
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          background: #000 url('https://images3.alphacoders.com/134/1342304.jpeg') no-repeat center center fixed;
          background-size: cover;
          color: white;
          display: grid;
          place-items: center;
          text-align: center;
        }
        .shell {
          width: min(100%, 640px);
        }
        .container {
          background: linear-gradient(180deg, rgba(0, 0, 0, 0.62), rgba(0, 0, 0, 0.8));
          padding: clamp(1rem, 3vw, 1.5rem) clamp(1rem, 4vw, 2rem);
          border-radius: 14px;
          width: 100%;
          box-shadow: 0 12px 30px rgba(0, 0, 0, 0.45);
        }
        h1 {
          margin: 0 0 0.4rem 0;
          font-size: clamp(1.2rem, 4.8vw, 1.9rem);
          line-height: 1.15;
          letter-spacing: 0.02em;
        }
        p {
          margin: 0 0 1rem 0;
          opacity: 0.9;
          font-size: clamp(0.85rem, 2.7vw, 1rem);
          overflow-wrap: anywhere;
        }
        .install-btn {
          display: inline-flex;
          justify-content: center;
          align-items: center;
          max-width: 100%;
          background-color: #8a5bb8;
          color: white;
          padding: 0.65rem 1.35rem;
          text-decoration: none;
          font-weight: bold;
          border-radius: 8px;
          transition: transform 0.2s, background 0.3s;
          font-size: 0.85rem;
          letter-spacing: 0.08em;
        }
        .install-btn:hover { background-color: #7a4ba8; transform: translateY(-1px); }
        @media (max-width: 640px) {
          body {
            background-attachment: scroll;
          }
          .container {
            border-radius: 10px;
          }
          .install-btn {
            width: 100%;
          }
        }
    </style>
</head>
<body>
    <main class="shell">
      <div class="container">
          <h1>Nakama Stream Hub</h1>
          <p>community addon gateway</p>
          <a href="${installUrl}" class="install-btn">INSTALL ADDON</a>
      </div>
    </main>
  </body>
</html>
  `.trim();
}

function projectPublicHealth() {
  return { status: "OK" };
}

module.exports = {
  renderLandingPage,
  projectPublicHealth
};
