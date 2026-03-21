const { supabase } = require("../lib/supabase");

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: "Method Not Allowed", detail: "Use GET", code: 405 }));
    return;
  }
  try {
    const { error } = await supabase.from("fixed_links").select("imdb_id").limit(1);
    if (error) throw new Error(error.message);
    res.statusCode = 200;
    res.end(JSON.stringify({ status: "ok", redis: "ok" }));
  } catch (e) {
    res.statusCode = 503;
    res.end(JSON.stringify({
      status: "error",
      redis: "error",
      detail: String(e && e.message ? e.message : e).slice(0, 500)
    }));
  }
};
