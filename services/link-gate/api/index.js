function renderPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Server D - Health</title>
  <style>
    :root {
      --bg: #0a0a0a;
      --card: #111111;
      --line: #242424;
      --muted: #7c7c7c;
      --text: #e4e4e4;
      --ok: #00ff5a;
      --err: #ff4444;
      --idle: #888888;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 16px;
      background: radial-gradient(circle at 20% 10%, #171717, var(--bg) 45%);
      color: var(--text);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }

    .card {
      width: min(100%, 460px);
      border: 1px solid var(--line);
      border-radius: 12px;
      background: linear-gradient(180deg, #121212, var(--card));
      box-shadow: 0 16px 40px #00000066;
      padding: 24px;
    }

    .header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 16px;
    }

    .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--idle);
      box-shadow: 0 0 8px #88888855;
      transition: background-color 150ms ease, box-shadow 150ms ease;
    }

    .title {
      letter-spacing: 0.1em;
      font-weight: 700;
      font-size: 1rem;
      text-transform: uppercase;
    }

    .subtitle {
      margin-top: 4px;
      color: var(--muted);
      font-size: 0.8rem;
    }

    .rule {
      border: none;
      border-top: 1px solid var(--line);
      margin: 14px 0 16px;
    }

    .status {
      color: var(--muted);
      font-size: 0.9rem;
      min-height: 1.3em;
      margin-bottom: 14px;
      text-transform: lowercase;
    }

    .status.ok {
      color: var(--ok);
    }

    .status.error {
      color: var(--err);
    }

    .check-btn {
      width: 100%;
      border: 1px solid #343434;
      background: #141414;
      color: var(--text);
      border-radius: 8px;
      padding: 10px 12px;
      font: inherit;
      cursor: pointer;
      transition: border-color 150ms ease;
    }

    .check-btn:hover {
      border-color: #555555;
    }

    .check-btn:disabled {
      opacity: 0.7;
      cursor: wait;
    }

    .check-btn.ok {
      border-color: var(--ok);
      color: var(--ok);
    }

    .check-btn.error {
      border-color: var(--err);
      color: var(--err);
    }
  </style>
</head>
<body>
  <main class="card">
    <div class="header">
      <span id="status-dot" class="dot" aria-hidden="true"></span>
      <div>
        <h1 class="title">Server D</h1>
        <p class="subtitle">health checker</p>
      </div>
    </div>

    <hr class="rule">

    <p id="status" class="status">press check</p>
    <button id="check-btn" class="check-btn" type="button">Check</button>
  </main>

  <script>
    (() => {
      const button = document.getElementById('check-btn');
      const status = document.getElementById('status');
      const dot = document.getElementById('status-dot');

      if (!button || !status || !dot) {
        return;
      }

      const setState = (state, label) => {
        button.classList.remove('ok', 'error');
        status.classList.remove('ok', 'error');

        if (state === 'loading') {
          status.textContent = 'checking';
          dot.style.backgroundColor = '#888888';
          dot.style.boxShadow = '0 0 8px #88888855';
          return;
        }

        if (state === 'ok') {
          button.classList.add('ok');
          status.classList.add('ok');
          status.textContent = label;
          dot.style.backgroundColor = '#00ff5a';
          dot.style.boxShadow = '0 0 10px #00ff5a66';
          return;
        }

        button.classList.add('error');
        status.classList.add('error');
        status.textContent = label;
        dot.style.backgroundColor = '#ff4444';
        dot.style.boxShadow = '0 0 10px #ff444466';
      };

      button.addEventListener('click', async () => {
        button.disabled = true;
        setState('loading', 'checking');

        try {
          const response = await fetch('/health', { method: 'GET' });
          if (response.ok) {
            setState('ok', 'ok');
          } else {
            setState('error', 'error');
          }
        } catch {
          setState('error', 'error');
        } finally {
          button.disabled = false;
        }
      });
    })();
  </script>
</body>
</html>`;
}

export default function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'method_not_allowed', detail: 'Use GET' });
  }

  return res
    .status(200)
    .setHeader('Content-Type', 'text/html; charset=utf-8')
    .end(renderPage());
}
