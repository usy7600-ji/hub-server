import { getClient } from './supabase.js';

function summarizeDbError(error) {
  if (!error) return '';
  return [error.message, error.details, error.hint].filter(Boolean).join(' ');
}

function isMissingColumn(error, columnName) {
  const text = summarizeDbError(error).toLowerCase();
  return text.includes('column') && text.includes(String(columnName || '').toLowerCase()) && text.includes('does not exist');
}

async function queryFixedLinks(client, imdbId, season, episode, selectClause) {
  return client
    .from('fixed_links')
    .select(selectClause)
    .eq('imdb_id', imdbId)
    .eq('season', season)
    .eq('episode', episode)
    .maybeSingle();
}

async function queryFixedLinkRpc(client, imdbId, season, episode) {
  return client.rpc('get_fixed_link', {
    p_imdb_id: imdbId,
    p_season: season,
    p_episode: episode,
  });
}

async function queryEpisodes(client, imdbId, season, episode, selectClause) {
  return client
    .from('episodes')
    .select(selectClause)
    .eq('imdb_id', imdbId)
    .eq('season', season)
    .eq('episode', episode)
    .maybeSingle();
}

function normalizeFixedLinkRow(row, fallbackFilename) {
  if (!row) return null;
  const fixedLink = String(row.fixed_link || row.url || '').trim();
  const filenameRaw = String(row.filename || row.file_name || '').trim();
  const filename = filenameRaw || String(fallbackFilename || '').trim();
  if (!fixedLink) {
    return null;
  }
  return { fixed_link: fixedLink, filename };
}

export async function lookupFixedLink(imdbId, season, episode) {
  const client = getClient();
  const fallbackFilename = `${imdbId}:${season}:${episode}`;

  const rpcRes = await queryFixedLinkRpc(client, imdbId, season, episode);
  if (!rpcRes.error) {
    const rpcRow = Array.isArray(rpcRes.data) ? rpcRes.data[0] : rpcRes.data;
    const normalizedRpc = normalizeFixedLinkRow(rpcRow, fallbackFilename);
    if (normalizedRpc) {
      return { data: normalizedRpc, error: null };
    }
  }

  let fixedRes = await queryFixedLinks(client, imdbId, season, episode, 'fixed_link, filename');
  if (fixedRes.error && isMissingColumn(fixedRes.error, 'filename')) {
    fixedRes = await queryFixedLinks(client, imdbId, season, episode, 'fixed_link, filename:file_name');
  }
  if (fixedRes.error && isMissingColumn(fixedRes.error, 'fixed_link')) {
    fixedRes = await queryFixedLinks(client, imdbId, season, episode, 'url:fixed_link, filename');
  }
  if (fixedRes.error && isMissingColumn(fixedRes.error, 'fixed_link') && isMissingColumn(fixedRes.error, 'filename')) {
    fixedRes = await queryFixedLinks(client, imdbId, season, episode, 'url:fixed_link, filename:file_name');
  }

  if (fixedRes.error) {
    return { data: null, error: fixedRes.error };
  }

  const normalizedFixed = normalizeFixedLinkRow(fixedRes.data, fallbackFilename);
  if (normalizedFixed) {
    return { data: normalizedFixed, error: null };
  }

  let episodeRes = await queryEpisodes(client, imdbId, season, episode, 'url, filename');
  if (episodeRes.error && isMissingColumn(episodeRes.error, 'filename')) {
    episodeRes = await queryEpisodes(client, imdbId, season, episode, 'url, filename:file_name');
  }

  if (episodeRes.error) {
    return { data: null, error: episodeRes.error };
  }

  const normalizedEpisode = normalizeFixedLinkRow(episodeRes.data, fallbackFilename);
  if (!normalizedEpisode) {
    return { data: null, error: null };
  }

  return { data: normalizedEpisode, error: null };
}
