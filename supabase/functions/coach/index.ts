// Wekelijkse AI-coach (Premium, Gemini). Zondagavond via pg_cron (x-cron-token) of zelf via POST met login.
// Per gebruiker: review van de week (kracht, lopen, voeding, herstel), feedback in app.coach_feedback,
// aanpassing van het loopplan voor volgende week (training_prefs.run_plan.adjust) en doelen per routine
// (training_prefs.targets) die de planner bij de krachtsessies toont.
import { createClient } from "npm:@supabase/supabase-js@2";
import { geminiLoop } from "./gemini.ts";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-latest";
const admin = createClient(URL_, SR, { auth: { persistSession: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-cron-token, content-type, apikey, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const asUser = (uid: string) => createClient(URL_, SR, { auth: { persistSession: false }, global: { headers: { "x-hh-user": uid } } });
const TZ = "Europe/Brussels";
const q = (s: string) => "'" + String(s).replace(/'/g, "''") + "'";
async function call<T = any>(db: any, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}
const monday = (iso: string) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); return d.toISOString().slice(0, 10); };
const add = (iso: string, n: number) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function runFor(uid: string) {
  const db = asUser(uid);
  const legacy = (await call<string>(admin, "internal_legacy_user")) === uid;
  const key = (await call<string | null>(db, "internal_get_secret", { p_name: "gemini_api_key" })) || (legacy ? Deno.env.get("GEMINI_API_KEY") ?? "" : "");
  if (!key) return { uid, skipped: "geen sleutel" };
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
  const wk = monday(today), sun = add(wk, 6);
  const [d] = await call<any[]>(db, "internal_agent_read", { q: `select
    (select display_name from app.profiles) as naam,
    (select value from app.settings where key = 'goals') as voedingsdoelen,
    (select value from app.settings where key = 'training_prefs') as prefs,
    (select jsonb_agg(jsonb_build_object('dag', day, 'titel', title, 'soort', category, 'status', status, 'notitie', note) order by day) from app.coach_sessions where day between ${q(wk)} and ${q(sun)}) as plan_deze_week,
    (select jsonb_agg(x order by x->>'dag') from (select jsonb_build_object('dag', day, 'training', workout_title, 'oefening', exercise, 'sets', jsonb_agg(jsonb_build_object('kg', weight_kg, 'reps', reps) order by set_index)) x
       from ai.strength_sets where set_type <> 'warmup' and day between ${q(add(wk, -14))} and ${q(sun)} group by day, workout_title, exercise) y) as kracht_3_weken,
    (select jsonb_agg(jsonb_build_object('dag', day, 'naam', name, 'min', duration_min, 'km', distance_km, 'hr', avg_hr, 'tempo', pace_min_per_km) order by day) from ai.workouts where day between ${q(add(wk, -14))} and ${q(sun)}) as cardio_3_weken,
    (select jsonb_build_object('kcal', round(avg(kcal_in)), 'eiwit', round(avg(protein_g)), 'gewicht', round(avg(weight_kg), 1), 'slaap', round(avg(sleep_h), 1), 'hrv', round(avg(hrv_ms)), 'rusthartslag', round(avg(resting_hr)))
       from ai.daily_summary where day between ${q(wk)} and ${q(sun)}) as week_gemiddeld,
    (select jsonb_build_object('gewicht', round(avg(weight_kg), 1)) from ai.daily_summary where day between ${q(add(wk, -7))} and ${q(add(wk, -1))}) as vorige_week,
    (select jsonb_agg(jsonb_build_object('id', id, 'naam', name, 'oefeningen', exercises)) from app.workout_templates where not archived) as routines` });
  const prefs = d?.prefs || {};
  const sys = `Je bent de persoonlijke coach van ${d?.naam || "de gebruiker"} in een fitnessapp. Nederlands, direct, eerlijk, concreet. Verzin geen cijfers: gebruik alleen de data.
Maak de weekreview van ${wk} t/m ${sun} en bereid volgende week voor. Antwoord met ALLEEN JSON:
{"samenvatting": "<2-3 zinnen>", "goed": "<1-3 korte punten gescheiden door ' · '>", "beter": "<1-3 korte punten>", "focus": "<de ene focus voor volgende week>",
 "loop_factor": <getal 0.8–1.1: omvang van de loopweek volgende week t.o.v. het plan; <1 bij gemiste runs, te hoge hartslag of slecht herstel, >1 alleen als alles vlot ging>,
 "loop_notitie": "<1 zin uitleg voor de loper, of leeg als er geen loopplan is>",
 "doelen": {"<routine-id>": "<per oefening het doel voor volgende keer: 'Oefening vorige → doel' met ' · ' ertussen; dubbele progressie: haalt hij in alle werksets het bovenste aantal reps, dan +2,5 kg (of 1 stap), anders zelfde gewicht en 1 rep meer>"},
 "stats": {"kracht_sessies": <n>, "cardio_min": <n>, "kcal_gem": <n|null>, "eiwit_gem": <n|null>, "gewicht_gem": <n|null>}}
Houd rekening met de grote doelen (prefs.goals) en het loopplan (prefs.run_plan) als die er zijn. Geen medische diagnoses.`;
  const { text } = await geminiLoop({ apiKey: key, model: MODEL, system: sys, tools: [], json: true, maxSteps: 2, run: async () => null,
    deadline: Date.now() + 90000, track: (m: string, l: boolean) => call(db, "internal_ai_usage_add", { p_model: m, p_limited: l }),
    userParts: [{ text: JSON.stringify(d).slice(0, 60000) }] });
  const out = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
  if (!out.samenvatting) throw new Error("Lege review");
  const fmt = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
  await call(db, "internal_save_week_feedback", { p: { day: sun, title: `Week ${fmt(wk)}–${fmt(sun)}`, summary: out.samenvatting,
    good: out.goed || "", improve: out.beter || "", focus: out.focus || "", stats: out.stats || {} } });
  // voorkeuren bijwerken: doelen per routine en aanpassing loopplan voor volgende week
  const next = { ...prefs, targets: { ...(prefs.targets || {}), ...(out.doelen || {}) } };
  if (prefs.run_plan?.date) {
    const start = monday(prefs.run_plan.created || today);
    const idx = Math.round((new Date(add(wk, 7) + "T12:00:00Z").getTime() - new Date(monday(start) + "T12:00:00Z").getTime()) / (7 * 864e5));
    const f = Math.min(1.1, Math.max(0.8, Number(out.loop_factor) || 1));
    next.run_plan = { ...prefs.run_plan, adjust: { ...(prefs.run_plan.adjust || {}), [idx]: { factor: f, note: out.loop_notitie || null } } };
  }
  await call(db, "internal_set_setting", { p_key: "training_prefs", p_value: next });
  await call(db, "internal_agent_write", { q: `insert into app.push_outbox (title, body, url) values ('Je weekreview staat klaar', ${q(String(out.focus || out.samenvatting).slice(0, 120))}, '/#/feedback')` });
  return { uid, ok: true };
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
      for (const u of users) { try { out.push(await runFor(u)); } catch (e) { out.push({ uid: u, error: String(e).slice(0, 300) }); } }
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
  const prem = await call<boolean>(asUser(u.user.id), "internal_is_premium");
  if (!prem) return json({ error: "Premium-functie" }, 403);
  try { return json(await runFor(u.user.id)); } catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 502); }
});
