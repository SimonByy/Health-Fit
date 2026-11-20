// Weekmenu met Gemini (Premium). Vrijdag via pg_cron of zelf via POST (login). Kiest uit je eigen recepten
// (met echte macro's), volgt je mealprep-regels en menuwensen, controleert de dagtotalen en stuurt één keer bij.
// Een goedgekeurde week (reviewed_at) wordt nooit overschreven.
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
const add = (iso: string, n: number) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const nextSunday = (iso: string) => { const d = new Date(iso + "T12:00:00Z"); const k = (7 - d.getUTCDay()) % 7 || 7; return add(iso, k); };
const SLOTS = ["ontbijt", "lunch", "snack", "avond", "avondsnack"];

function totals(items: any[], R: Map<number, any>) {
  const by: Record<string, any> = {};
  for (const it of items) {
    const r = R.get(Number(it.recipe_id)); if (!r) continue;
    const t = (by[it.day] ||= { kcal: 0, eiwit: 0, vet: 0, kh: 0 });
    const p = Number(it.portions) || 1;
    t.kcal += (r.kcal || 0) * p; t.eiwit += (r.protein || 0) * p; t.vet += (r.fat || 0) * p; t.kh += (r.carbs || 0) * p;
  }
  for (const k in by) for (const m in by[k]) by[k][m] = Math.round(by[k][m]);
  return by;
}
function clean(items: any[], R: Map<number, any>, days: string[]) {
  const seen = new Set<string>();
  return (items || []).map((it) => {
    const r = R.get(Number(it.recipe_id));
    if (!r || r.disliked || !days.includes(it.day) || !SLOTS.includes(it.slot)) return null;
    const step = Number(r.portion_step) || 1;
    const portions = Math.max(step, Math.round((Number(it.portions) || 1) / step) * step);
    const k = it.day + it.slot; if (seen.has(k)) return null; seen.add(k);
    return { day: it.day, slot: it.slot, recipe_id: r.id, portions };
  }).filter(Boolean) as any[];
}

async function runFor(uid: string, force = false, dry = false, scheduled = false) {
  const db = asUser(uid);
  const legacy = (await call<string>(admin, "internal_legacy_user")) === uid;
  const key = (await call<string | null>(db, "internal_get_secret", { p_name: "gemini_api_key" })) || (legacy ? Deno.env.get("GEMINI_API_KEY") ?? "" : "");
  if (!key) return { uid, skipped: "geen sleutel" };
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
  const W = nextSunday(today);
  const days = Array.from({ length: 6 }, (_, i) => add(W, i)); // zondag t/m vrijdag
  const [d] = await call<any[]>(db, "internal_agent_read", { q: `select
    (select value from app.settings where key = 'goals') as doelen,
    (select value from app.settings where key = 'mealprep') as regels,
    (select reviewed_at is not null from app.mp_weeks where week_start = ${q(W)}) as al_goedgekeurd,
    (select jsonb_agg(jsonb_build_object('id', id, 'tekst', text, 'status', status)) from app.menu_wishes where created_at > now() - interval '10 days' and status <> 'klaar') as wensen,
    (select jsonb_agg(jsonb_build_object('id', id, 'naam', name, 'maaltijd', meal_type, 'kcal', kcal, 'eiwit', protein, 'kh', carbs, 'vet', fat, 'stap', portion_step,
        'favoriet', favorite, 'notitie', note, 'bewaren', storage) order by name)
       from app.mp_recipes where not coalesce(hidden, false) and not coalesce(disliked, false) and status = 'klaar' and kcal is not null) as recepten,
    (select jsonb_agg(jsonb_build_object('week', w.week_start, 'dag', i.day, 'slot', i.slot, 'recept', i.recipe_id) order by i.day)
       from app.mp_week_items i join app.mp_weeks w on w.id = i.week_id where w.week_start >= ${q(add(W, -28))} and w.week_start < ${q(W)}) as vorige_weken` });
  // Automatisch weekmenu uitgezet in de app (Menu → Automatisch weekmenu): de vrijdagse run slaat je over; zelf vragen kan nog
  if (scheduled && d?.regels?.auto === false) return { uid, skipped: "automatisch uit" };
  if (d?.al_goedgekeurd && !force && !dry) return { uid, skipped: "al goedgekeurd" };
  const recipes = d?.recepten || [];
  if (recipes.length < 4) return { uid, skipped: "te weinig recepten" };
  const R = new Map<number, any>(recipes.map((r: any) => [Number(r.id), { ...r, protein: r.eiwit, fat: r.vet, carbs: r.kh, portion_step: r.stap }]));
  const g = d?.doelen || {};
  const sys = `Je bent de mealprep-planner in een fitnessapp. Maak het weekmenu van zondag ${W} (avond) tot en met vrijdag ${days[5]} (middag). Nederlands.
Gebruik ALLEEN recepten uit de lijst (recipe_id = id) bij een passende maaltijd. Volg de regels (regels) en de wensen (wensen wegen zwaarder dan variatie).
Variatie: niet hetzelfde als vorige weken waar het kan; hoogstens 2 verschillende avondgerechten (elk 2-3 dagen), 2 verschillende lunches, snacks afwisselen.
Portions: een veelvoud van 'stap' van dat recept. Doel per volle dag (ma t/m do): ${g.kcal_in ?? "?"} kcal (±50), minstens ${g.protein_g ?? "?"} g eiwit, hoogstens ${(g.fat_g ?? 50) + 5} g vet.
Alles wordt zondag gekookt: wat donderdag/vrijdag gegeten wordt, gaat in de diepvries.
Antwoord met ALLEEN JSON: {"items":[{"day":"YYYY-MM-DD","slot":"ontbijt|lunch|snack|avond|avondsnack","recipe_id":<id>,"portions":<getal>}],
"prep":["<genummerde kookstap voor zondag met tijd en wat in koelkast/diepvries gaat>"], "notes":"<2-3 zinnen: wat er deze week in zit en waarom>", "wish_ids":[<ids van wensen die je meenam>]}`;
  const t0 = Date.now();
  const ask = async (extra: any, ms: number) => {
    const { text } = await geminiLoop({ apiKey: key, model: MODEL, system: sys, tools: [], json: true, maxSteps: 2, run: async () => null,
      deadline: Date.now() + ms, callTimeout: Math.min(ms, 65000), maxTokens: 8192, track: (m: string, l: boolean) => call(db, "internal_ai_usage_add", { p_model: m, p_limited: l }),
      userParts: [{ text: JSON.stringify({ ...d, recepten: recipes, ...extra }).slice(0, 80000) }] });
    return JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
  };
  let out = await ask({}, 95000);
  let items = clean(out.items, R, days);
  // één correctieronde als dagen buiten het doel vallen
  const t = totals(items, R);
  const off = days.slice(1, 5).filter((x) => t[x] && (Math.abs(t[x].kcal - (g.kcal_in || 2000)) > 80 || t[x].eiwit < (g.protein_g || 0) - 5));
  if (off.length && g.kcal_in && Date.now() - t0 < 70000) {
    const fix: any = await ask({ vorig_voorstel: items, dagtotalen: t, opdracht: `Deze dagen zitten niet goed: ${off.join(", ")}. Pas porties aan (veelvoud van stap) of voeg een snack/avondsnack toe zodat elke dag klopt. Geef het volledige menu opnieuw.` }, 135000 - (Date.now() - t0)).catch(() => ({}));
    const items2 = clean(fix?.items, R, days);
    if (items2.length >= items.length * 0.8) { items = items2; out = { ...out, ...fix }; }
  }
  const tt = totals(items, R);
  const sum = days.slice(1, 5).map((x) => tt[x] ? `${new Date(x + "T12:00:00Z").toLocaleDateString("nl-BE", { weekday: "short", timeZone: "UTC" })} ${tt[x].kcal} kcal/${tt[x].eiwit} g eiwit` : "").filter(Boolean).join(" · ");
  if (dry) return { uid, dry: true, week: W, items: items.length, totals: tt, notes: out.notes, prep: (out.prep || []).length };
  const res = await call(db, "internal_save_menu_week", { p: { week_start: W, items, prep: out.prep || [], notes: [out.notes, sum ? `Dagtotalen: ${sum}.` : ""].filter(Boolean).join(" "),
    wish_ids: out.wish_ids || [], wish_answer: `Zit in je menu van ${W.slice(8, 10)}/${W.slice(5, 7)}.` } });
  if (!res?.skipped) await call(db, "internal_agent_write", { q: `insert into app.push_outbox (title, body, url) values ('Je weekmenu staat klaar', ${q("Kijk het na en pas aan waar je wil. " + (sum ? sum.slice(0, 80) : ""))}, '/#/menu/week')` });
  return { uid, ok: true, ...res };
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
      for (const u of users) { try { out.push(await runFor(u, false, !!body.dry, true)); } catch (e) { out.push({ uid: u, error: String(e).slice(0, 300) }); } }
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
  if (!(await call<boolean>(asUser(u.user.id), "internal_is_premium"))) return json({ error: "Premium-functie" }, 403);
  try { return json(await runFor(u.user.id, !!body.force)); } catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 502); }
});
