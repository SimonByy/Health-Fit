// Ontvangt Apple Health-data van de iOS-app "Health Auto Export" (REST API-automatisatie)
// Auth: header  Authorization: Bearer <ingest_token>   (of x-ingest-token, of ?token=)
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-ingest-token, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Gebruik POST" }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  const url = new URL(req.url);
  const provided =
    req.headers.get("x-ingest-token") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    url.searchParams.get("token") ??
    "";

  const { data: expected, error: secErr } = await admin.rpc("internal_get_secret", { p_name: "ingest_token" });
  if (secErr || !expected) return json({ error: "Server niet geconfigureerd" }, 500);
  if (!provided || !timingSafeEqual(provided, expected as string)) return json({ error: "Ongeldig token" }, 401);

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Body is geen geldige JSON" }, 400);
  }

  const { data, error } = await admin.rpc("ingest_health_export", { p: payload });
  if (error) {
    await admin.rpc("sync_state_set", {
      p_source: "apple_health", p_cursor: null, p_ok: false, p_items: 0, p_error: error.message,
    });
    return json({ error: error.message }, 500);
  }
  return json({ ok: true, ...(data as Record<string, unknown>) });
});
