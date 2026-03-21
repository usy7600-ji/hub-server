# Nakama Hub Server

Unified server name: `nakama-hub-server`

This runs all 4 codebases behind one server entrypoint:

- `stream-addon` at `/`
- `link-broker` at `/broker/*`
- `link-gate` at `/gate/*`
- `link-worker` at `/worker/*`

Run:

```bash
npm start
```

Vercel is configured with `vercel.json` to route every request through `api/gateway.js`.

Quick health checks:

- `/combined/health`
- `/broker/api/health`
- `/gate/api/health`
- `/worker/health`
