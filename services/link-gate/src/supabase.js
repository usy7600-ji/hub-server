import { createClient } from '@supabase/supabase-js';
import { env, envError } from './env.js';

let _client = null;
let _initPromise = null;

export function getClient() {
  if (!_client && !envError) {
    _client = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
  }
  return _client;
}

export function ensureConnected() {
  if (!_initPromise) {
    _initPromise = _init();
  }
  return _initPromise;
}

async function _init() {
  if (envError) return null;

  try {
    await fetch(env.SUPABASE_URL);
    return null;
  } catch {
    return 'Supabase connectivity check failed';
  }
}
