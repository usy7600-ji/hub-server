import { envError } from '../src/env.js';
import { ensureConnected, getClient } from '../src/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  if (envError) {
    return res.status(503).json({ status: 'error', supabase: 'error', detail: envError });
  }

  const connError = await ensureConnected();
  if (connError) {
    return res.status(503).json({ status: 'error', supabase: 'error', detail: connError });
  }

  const { error } = await getClient().from('fixed_links').select('imdb_id').limit(1);

  if (error) {
    return res.status(503).json({ status: 'error', supabase: 'error', detail: String(error.message || error) });
  }

  return res.status(200).json({ status: 'ok', supabase: 'ok' });
}
