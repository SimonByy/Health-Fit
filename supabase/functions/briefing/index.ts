// Ochtendbriefing met Gemini voor elke gebruiker (behalve de oorspronkelijke gebruiker: die heeft een Claude-taak).
// pg_cron roept dit elke 15 minuten aan tussen 6 en 11 uur (x-cron-token). Per gebruiker:
// - alleen met toestemming en een eigen Gemini-sleutel
// - één keer per dag, vanaf het uur in app.settings 'briefing' {"time":"07:30"} (standaard 07:30)
// Een ingelogde gebruiker kan ook zelf POST {now:true} sturen (bv. knop "Maak mijn briefing").
import { createClient } from "npm:@supabase/supabase-js@2";
import { geminiLoop } from "./gemini.ts";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-latest";
const admin = createClient(URL_, SR, { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-cron-token, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const asUser = (uid: string) => createClient(URL_, SR, { auth: { persistSession: false }, global: { headers: { "x-hh-user": uid } } });
const TZ = "Europe/Brussels";
const q = (s: string) => "'" + String(s).replace(/'/g, "''") + "'";

async function call<T = any>(db: any, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

async function weather(loc: any) {
  if (!loc?.lat || !loc?.lon) return null;
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&hourly=precipitation_probability,precipitation&daily=temperature_2m_max,precipitation_sum&timezone=Europe%2FBrussels&forecast_days=1`;
    const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const d = await r.json();
    const rain = (d.hourly?.time ?? []).map((t: string, i: number) => ({ h: Number(t.slice(11, 13)), p: d.hourly.precipitation_probability?.[i], mm: d.hourly.precipitation?.[i] }))
      .filter((x: any) => x.h >= 8 && x.h <= 22 && (x.p >= 50 || x.mm >= 0.3)).map((x: any) => x.h);
    return { plaats: loc.name ?? null, max_temp: d.daily?.temperature_2m_max?.[0], regen_uren: rain };
  } catch { return null; }
}

async function makeFor(uid: string, force = false) {
  const db = asUser(uid);
  const key = await call<string | null>(db, "internal_get_secret", { p_name: "gemini_api_key" });
  if (!key) return { uid, skipped: "geen sleutel" };
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
  const nowHm = new Date().toLocaleTimeString("nl-BE", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
  const cfg = (await call<any>(db, "internal_get_setting", { p_key: "briefing" })) || {};
  if (cfg.enabled === false && !force) return { uid, skipped: "uit" };
  if (!force && nowHm < String(cfg.time || "07:30")) return { uid, skipped: "te vroeg" };
  const [{ done } = { done: false }] = await call<any[]>(db, "internal_agent_read", { q: `select exists (select 1 from app.briefings where day = ${q(today)}) as done` });
  if (done && !force) return { uid, skipped: "al gemaakt" };

  // Gegevens van vandaag (alles binnen deze gebruiker, via RLS)
  const [data] = await call<any[]>(db, "internal_agent_read", { q: `select
    (select display_name from app.profiles) as naam,
    (select value from app.settings where key = 'goals') as doelen,
    (select to_jsonb(s) from (select day, total_h, deep_h, rem_h, awake_h, sleep_start_local, sleep_end_local from ai.sleep
       where day = ${q(today)} order by total_h desc nulls last limit 1) s) as slaap,
    (select to_jsonb(r) from (select sleep_score, hrv_ms, resting_hr, body_battery_wake from ai.recovery_daily where day = ${q(today)}) r) as herstel,
    (select jsonb_build_object('hrv', round(avg(hrv_ms)), 'rusthartslag', round(avg(resting_hr), 1)) from ai.recovery_daily where day between ${q(today)}::date - 7 and ${q(today)}::date - 1) as gemiddeld,
    (select jsonb_agg(jsonb_build_object('titel', title, 'soort', kind, 'details', details)) from app.coach_sessions where day = ${q(today)} and status = 'gepland') as training,
    (select jsonb_agg(jsonb_build_object('maaltijd', i.slot, 'gerecht', r.name, 'week_start', w.week_start)) from app.mp_week_items i
       join app.mp_recipes r on r.id = i.recipe_id join app.mp_weeks w on w.id = i.week_id where i.day = ${q(today)}) as menu,
    (select jsonb_build_object('kcal', round(avg(kcal_in)), 'eiwit', round(avg(protein_g))) from ai.daily_summary
       where day between ${q(today)}::date - 7 and ${q(today)}::date - 1 and kcal_in > 800) as voeding_week` });
  const wx = await weather(cfg.location);
  const weekday = new Date().toLocaleDateString("nl-BE", { timeZone: TZ, weekday: "long" });
  const name = data?.naam || "";

  const sys = `Je schrijft de ochtendbriefing van ${name || "de gebruiker"} in een gezondheidsapp. Nederlands, gewone spreektaal, korte zinnen: de tekst wordt voorgelezen (ongeveer 1 minuut). Geen opsommingstekens, emoji, markdown of tabellen. Eerlijk: verzin niets; ontbreekt iets, sla het over.
Precies deze onderdelen, in deze volgorde:
1. "Goeiemorgen${name ? " " + name : ""}, het is ${weekday}." Daarna in één zin het weer als dat er is (regent het en wanneer, of droog, met de maximumtemperatuur).
2. Slaap: duur en slaapscore in één zin. Was de score lager dan ongeveer 85 of valt er iets op (laat ingeslapen, veel wakker, weinig diepe slaap), geef één concrete tip voor de volgende nacht. Was de slaap goed, zeg dat kort. HRV, rusthartslag of Body Battery bij opstaan alleen noemen als ze duidelijk afwijken van het gemiddelde; neutraal, geen diagnose.
3. Training: wat er vandaag gepland staat, zonder uur en zonder oefeningen op te sommen. Niets gepland: zeg kort dat het een rustdag is of sla over. Alleen bij duidelijk slecht herstel één zin advies.
4. Eten: het ontbijt van vandaag uit het menu. Komt een lunch of avondgerecht uit de diepvries (donderdag of vrijdag, minstens 4 dagen na week_start), zeg "Vergeet je <gerecht> niet uit de diepvries te halen." Geen menu: sla over.
5. Afsluiter: geen vraag, één korte warme zin zoals "Een fijne dag toegewenst!"
Antwoord met alleen de tekst van de briefing.`;
  const { text } = await geminiLoop({ apiKey: key, model: MODEL, system: sys, tools: [], run: async () => null, maxSteps: 2,
    deadline: Date.now() + 60000,
    track: (m: string, l: boolean) => call(db, "internal_ai_usage_add", { p_model: m, p_limited: l }),
    userParts: [{ text: JSON.stringify({ vandaag: today, weer: wx, ...data }).slice(0, 20000) }] });
  const brief = String(text || "").trim();
  if (brief.length < 40) throw new Error("Lege briefing");
  await call(db, "internal_save_briefing", { p_day: today, p_text: brief });
  await call(db, "internal_agent_write", { q: `insert into app.push_outbox (title, body, url) values ('Goeiemorgen ☀️', 'Je briefing staat klaar. Tik om te luisteren.', '/#/briefing/autoplay')` });
  return { uid, ok: true, len: brief.length };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST" }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { /* leeg */ }
  const cron = req.headers.get("x-cron-token");
  if (cron) {
    const expected = await call<string>(admin, "internal_get_secret", { p_name: "cron_token" });
    if (!expected || cron !== expected) return json({ error: "Geen toegang" }, 401);
    const users = await call<string[]>(admin, "internal_briefing_users");
    const work = (async () => {
      const out = [];
      for (const u of users) { try { out.push(await makeFor(u)); } catch (e) { out.push({ uid: u, error: String(e).slice(0, 200) }); } }
      console.log(JSON.stringify(out));
      return out;
    })();
    const rt = (globalThis as any).EdgeRuntime;
    if (rt?.waitUntil && !body.wait) { rt.waitUntil(work); return json({ accepted: users.length }, 202); }
    return json({ results: await work });
  }
  const jwt = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Niet ingelogd" }, 401);
  const { data: u } = await admin.auth.getUser(jwt);
  if (!u?.user || !(await call<boolean>(admin, "internal_is_owner", { p_uid: u.user.id }))) return json({ error: "Geen toegang" }, 403);
  try { return json(await makeFor(u.user.id, true)); }
  catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 502); }
});
