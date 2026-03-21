import { env, envError } from '../src/env.js';
import { randomUUID } from 'node:crypto';
import { lookupFixedLink } from '../src/db.js';
import { forwardToB } from '../src/forward.js';
import { ensureConnected } from '../src/supabase.js';
import { summarizeDetail, toDetailString } from '../src/http-detail.js';

function parseEpisodeId(episodeId) {
  if (typeof episodeId !== 'string') return { error: 'episodeId must be a string' };
  const value = episodeId.trim();
  if (!value) return { error: 'episodeId cannot be empty' };
  const parts = value.split(':');
  if (parts.length < 3) return { error: 'episodeId must be imdb_id:season:episode' };
  const [imdb_id, seasonRaw, episodeRaw] = parts;
  const season = Number.parseInt(seasonRaw, 10);
  const episode = Number.parseInt(episodeRaw, 10);
  if (!imdb_id) return { error: 'episodeId must include imdb_id' };
  if (!Number.isInteger(season) || season <= 0) return { error: 'season must be a positive integer' };
  if (!Number.isInteger(episode) || episode <= 0) return { error: 'episode must be a positive integer' };
  return { data: { imdb_id, season, episode } };
}

function getResolveInput(req) {
  const source = req.method === 'GET' ? req.query : req.body;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return {};
  }
  return source;
}

function extractCorrelationId(req) {
  const candidate = String(req?.headers?.['x-correlation-id'] || '').trim();
  if (candidate) {
    return candidate;
  }
  return randomUUID();
}

function logResolveError({ req, correlationId, event, error, detail, message, extra = {} }) {
  const requestId = String(req?.headers?.['x-request-id'] || '').trim() || correlationId;
  console.error(JSON.stringify({
    server: 'D',
    event,
    error,
    detail,
    requestId,
    correlationId,
    method: String(req?.method || 'unknown'),
    path: '/api/resolve',
    ts: new Date().toISOString(),
    message,
    ...extra,
  }));
}

export function buildResolveHandler(deps = {}) {
  const {
    envData = env,
    envErrorValue = envError,
    ensureConnectedFn = ensureConnected,
    lookupFixedLinkFn = lookupFixedLink,
    forwardToBFn = forwardToB,
  } = deps;

  return async function handler(req, res) {
    const correlationId = extractCorrelationId(req);
    console.log(JSON.stringify({ correlationId, event: 'request_received', endpoint: '/api/resolve' }));

    if (envErrorValue) {
      logResolveError({
        req,
        correlationId,
        event: 'env_error',
        error: 'env_error',
        detail: toDetailString(envErrorValue),
        message: `Server D could not process /api/resolve because environment configuration is invalid: ${summarizeDetail(envErrorValue)}`,
      });
      return res.status(500).json({ error: 'env_error', detail: envErrorValue });
    }

    if (req.method !== 'POST' && req.method !== 'GET') {
      logResolveError({
        req,
        correlationId,
        event: 'method_not_allowed',
        error: 'method_not_allowed',
        detail: 'Use GET or POST',
        message: `Server D rejected /api/resolve because method ${String(req.method || 'unknown')} is not allowed; expected GET or POST.`,
      });
      return res.status(405).json({ error: 'method_not_allowed', detail: 'Use GET or POST' });
    }

    const connError = await ensureConnectedFn();
    if (connError) {
      logResolveError({
        req,
        correlationId,
        event: 'db_error',
        error: 'db_error',
        detail: toDetailString(connError),
        message: `Server D could not process /api/resolve because the database connection check failed: ${summarizeDetail(connError)}.`,
        extra: { stage: 'connection' },
      });
      return res.status(500).json({ error: 'db_error', detail: connError });
    }

    const input = getResolveInput(req);
    const hasEpisodeId = input && typeof input === 'object' && Object.hasOwn(input, 'episodeId');

    let parsed;
    if (hasEpisodeId) {
      parsed = parseEpisodeId(input.episodeId);
    } else {
      const imdb_id = String(input?.imdb_id || '').trim();
      const season = Number.parseInt(String(input?.season ?? ''), 10);
      const episode = Number.parseInt(String(input?.episode ?? ''), 10);
      if (!imdb_id || !Number.isFinite(season) || !Number.isFinite(episode)) {
        logResolveError({
          req,
          correlationId,
          event: 'bad_request',
          error: 'bad_request',
          detail: 'Provide episodeId or imdb_id + season + episode',
          message: `Server D rejected /api/resolve because required fields were missing; received imdb_id="${imdb_id}", season="${String(input?.season ?? '')}", episode="${String(input?.episode ?? '')}".`,
          extra: { stage: 'missing_fields' },
        });
        return res.status(400).json({ error: 'bad_request', detail: 'Provide episodeId or imdb_id + season + episode' });
      }
      if (season < 1) {
        parsed = { error: 'season must be a positive integer' };
      } else if (episode < 1) {
        parsed = { error: 'episode must be a positive integer' };
      } else {
        parsed = { data: { imdb_id, season, episode } };
      }
    }

    if (parsed.error) {
      logResolveError({
        req,
        correlationId,
        event: 'bad_request',
        error: 'bad_request',
        detail: parsed.error,
        message: `Server D rejected /api/resolve because episode input was invalid: ${parsed.error}.`,
        extra: { stage: 'parse_error' },
      });
      return res.status(400).json({ error: 'bad_request', detail: parsed.error });
    }

    const { imdb_id: imdbId, season, episode } = parsed.data;

    const { data, error } = await lookupFixedLinkFn(imdbId, season, episode);

    if (error) {
      logResolveError({
        req,
        correlationId,
        event: 'db_error',
        error: 'db_error',
        detail: toDetailString(error),
        message: `Server D could not read fixed-link data for ${imdbId}:${season}:${episode} because the database lookup failed: ${summarizeDetail(error)}.`,
        extra: { stage: 'fixed_link_lookup' },
      });
      return res.status(500).json({ error: 'db_error', detail: 'Fixed link lookup failed' });
    }

    if (data !== null) {
      return res.status(200).json({ url: data.fixed_link, filename: data.filename });
    }

    const { data: bData, error: bError } = await forwardToBFn(
      envData.SERVER_B_URL,
      {
        imdb_id: imdbId,
        season,
        episode,
      },
      correlationId
    );

    if (bError) {
      logResolveError({
        req,
        correlationId,
        event: 'upstream_failed',
        error: 'upstream_failed',
        detail: toDetailString(bError),
        message: `Server D could not forward ${imdbId}:${season}:${episode} to Server B because upstream returned an error: ${summarizeDetail(bError)}.`,
        extra: { stage: 'server_b_error' },
      });
      return res.status(502).json({ error: 'upstream_failed', detail: bError });
    }

    if (!bData || typeof bData.url !== 'string' || typeof bData.filename !== 'string') {
      logResolveError({
        req,
        correlationId,
        event: 'upstream_failed',
        error: 'upstream_failed',
        detail: toDetailString(bData),
        message: `Server D received an invalid resolve payload from Server B for ${imdbId}:${season}:${episode}; expected string url and filename but received: ${summarizeDetail(bData)}.`,
        extra: { stage: 'invalid_upstream_payload' },
      });
      return res.status(502).json({ error: 'upstream_failed', detail: 'invalid_upstream_payload' });
    }

    return res.status(200).json({ url: bData.url, filename: bData.filename });
  };
}

const handler = buildResolveHandler();

export default handler;
