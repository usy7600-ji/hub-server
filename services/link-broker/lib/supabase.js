const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

let _supabaseClient = null;
if (SUPABASE_URL && SERVICE_ROLE) {
  _supabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const supabase = new Proxy({}, {
  get(_, prop) {
    if (_supabaseClient) return _supabaseClient[prop];
    throw new Error("Supabase client not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  },
});

module.exports = { supabase };
