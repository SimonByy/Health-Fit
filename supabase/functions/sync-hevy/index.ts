// Synchroniseert Hevy-trainingen via de officiële Hevy API (vereist Hevy Pro).
// Aangeroepen door pg_cron (header x-cron-token) of door de app (ingelogde eigenaar).
// Body (optioneel): { "full": true }  -> alles opnieuw ophalen
import { createClient } from "npm:@supabase/supabase-js@2";

const HEVY = "https://api.hevyapp.com/v1";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-cron-token, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

async function rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await admin.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

async function isAuthorized(req: Request): Promise<boolean> {
  const cron = req.headers.get("x-cron-token");
  if (cron) {
    const expected = await rpc<string>("internal_get_secret", { p_name: "cron_token" });
    return !!expected && cron === expected;
  }
  const jwt = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!jwt) return false;
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data.user) return false;
  return await rpc<boolean>("internal_is_owner", { p_uid: data.user.id });
}

async function hevyGet(path: string, key: string) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${HEVY}${path}`, { headers: { "api-key": key, accept: "application/json" } });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Hevy ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return await res.json();
  }
  throw new Error("Hevy rate limit");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!(await isAuthorized(req))) return json({ error: "Geen toegang" }, 401);

  let full = false;
  try {
    full = !!(await req.json())?.full;
  } catch { /* geen body */ }

  const key = await rpc<string | null>("internal_get_secret", { p_name: "hevy_api_key" });
  if (!key) return json({ ok: false, error: "Geen Hevy API-key ingesteld (Instellingen in de app)" }, 400);

  const state = await rpc<{ cursor?: string } | null>("sync_state_get", { p_source: "hevy" });
  const since = full || !state?.cursor ? "1970-01-01T00:00:00Z" : state.cursor;
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + 120_000;

  let updated = 0, deleted = 0, templates = 0, complete = false;
  try {
    // 1) oefening-templates (spiergroepen) — max. 1x per week of bij volledige sync
    const tplState = await rpc<{ last_success?: string } | null>("sync_state_get", { p_source: "hevy_templates" });
    const tplAge = tplState?.last_success ? Date.now() - Date.parse(tplState.last_success) : Infinity;
    if (full || tplAge > 7 * 864e5) {
      for (let page = 1; page < 100; page++) {
        const r = await hevyGet(`/exercise_templates?page=${page}&pageSize=100`, key);
        const list = r?.exercise_templates ?? [];
        if (list.length) templates += await rpc<number>("hevy_upsert_templates", { p: list });
        if (!r || page >= (r.page_count ?? 0) || !list.length) break;
      }
      await rpc("sync_state_set", { p_source: "hevy_templates", p_cursor: null, p_ok: true, p_items: templates, p_error: null });
    }

    // 2) workout-events sinds de vorige sync (updates + verwijderingen)
    for (let page = 1; Date.now() < deadline; page++) {
      const r = await hevyGet(`/workouts/events?page=${page}&pageSize=10&since=${encodeURIComponent(since)}`, key);
      const events: any[] = r?.events ?? [];
      const ups = events.filter((e) => e.type === "updated" && e.workout).map((e) => e.workout);
      const dels = events.filter((e) => e.type === "deleted").map((e) => e.id ?? e.workout?.id).filter(Boolean);
      if (ups.length) updated += await rpc<number>("hevy_upsert_workouts", { p: ups });
      if (dels.length) deleted += await rpc<number>("hevy_delete_workouts", { p_ids: dels });
      if (!r || !events.length || page >= (r.page_count ?? 0)) {
        complete = true;
        break;
      }
    }

    await rpc("sync_state_set", {
      p_source: "hevy",
      p_cursor: complete ? startedAt : null, // onvolledig -> volgende run gaat verder vanaf oude cursor
      p_ok: true,
      p_items: updated + deleted,
      p_error: complete ? null : "Gedeeltelijk (tijdslimiet) — volgende sync gaat verder",
    });
    return json({ ok: true, complete, updated, deleted, templates });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await rpc("sync_state_set", { p_source: "hevy", p_cursor: null, p_ok: false, p_items: updated, p_error: msg });
    return json({ ok: false, error: msg, updated, deleted }, 500);
  }
});
