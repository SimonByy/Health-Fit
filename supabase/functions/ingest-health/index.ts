// Ontvangt Apple Health-data: dagtotalen uit iOS Opdrachten (gratis) of Health Auto Export.
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

  // het token bepaalt de gebruiker; daarna gaat alles via de header x-hh-user (alleen geldig met de service-sleutel)
  if (provided.length < 16) return json({ error: "Ongeldig token" }, 401);
  const { data: uid } = await admin.rpc("internal_user_by_secret", { p_name: "ingest_token", p_value: provided });
  if (!uid) return json({ error: "Ongeldig token" }, 401);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false }, global: { headers: { "x-hh-user": String(uid) } } });

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Body is geen geldige JSON" }, 400);
  }

  // Dagtotalen uit iOS Opdrachten of Health Auto Export-formaat.
  // Opdrachten mag plat sturen: {"date":"2026-10-05","step_count":8234,"protein":150,...}
  let p = payload as Record<string, unknown>;
  if (!p || typeof p !== "object" || Array.isArray(p)) return json({ error: "Verwacht een JSON-object" }, 400);
  const isHae = "data" in p || "metrics" in p || "workouts" in p;
  if (!isHae && !("values" in p) && !("days" in p)) {
    const { date, ...rest } = p;
    p = { date, values: rest };
  }
  const { data, error } = await db.rpc(isHae ? "ingest_health_export" : "ingest_daily_values", { p });
  if (error) {
    await db.rpc("sync_state_set", {
      p_source: "apple_health", p_cursor: null, p_ok: false, p_items: 0, p_error: error.message,
    });
    return json({ error: error.message }, 500);
  }
  return json({ ok: true, ...(data as Record<string, unknown>) });
});
