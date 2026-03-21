# Hub Server

Production-ready unified Stremio addon server.

## Endpoints

- `GET /` addon landing page
- `GET /manifest.json` Stremio manifest
- `GET /catalog/:type/:id.json` Stremio catalog
- `GET /stream/:type/:id.json` Stremio stream resolution
- `GET /api/resolve?episodeId=tt0388629:1:1` direct resolve API
- `GET /health` health status

## Local run

```bash
npm start
```

## Runtime assets

- `data/episodes/*.json` episode source catalog
- `bin/dlp-jipi` and `bin/yt-dlp` media URL resolver binaries

## Vercel

All routes are rewritten to `api/gateway.js`, which serves the unified handler.
