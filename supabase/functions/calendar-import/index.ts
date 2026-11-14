// Optioneel: je eigen agenda inlezen via de geheime iCal-link (Google Agenda: "Geheim adres in iCal-indeling",
// iCloud: openbare agenda-link). Bewaart alleen de komende 3 weken (dag, begin, einde, titel); vervangt elke keer alles.
// POST met login (nu ophalen) of via pg_cron (x-cron-token, alle gekoppelde gebruikers).
import { createClient } from "npm:@supabase/supabase-js@2";
import { parseIcs } from "./ics.ts";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(URL_, SR, { auth: { persistSession: false } });
const asUser = (uid: string) => createClient(URL_, SR, { auth: { persistSession: false }, global: { headers: { "x-hh-user": uid } } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-cron-token, content-type, apikey, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const TZ = "Europe/Brussels";
async function call<T = any>(db: any, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}
const addDays = (iso: string, n: number) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function fetchIcs(url: string) {
  const u = new URL(url.replace(/^webcal:/i, "https:"));
  if (u.protocol !== "https:") throw new Error("Alleen https-links");
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/.test(u.hostname) || !u.hostname.includes(".")) throw new Error("Ongeldige link");
  const res = await fetch(u, { signal: AbortSignal.timeout(15000), redirect: "follow", headers: { accept: "text/calendar, */*" } });
  if (!res.ok) throw new Error(res.status === 404 || res.status === 403 ? "De agenda geeft geen toegang (link verlopen of niet openbaar?)" : `Agenda antwoordt met ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > 8_000_000) throw new Error("Agenda te groot (> 8 MB)");
  const text = new TextDecoder().decode(buf);
  if (!text.includes("BEGIN:VCALENDAR")) throw new Error("Dit is geen agenda in iCal-formaat");
  return text;
}

async function runFor(uid: string) {
  const db = asUser(uid);
  const url = await call<string | null>(db, "internal_get_secret", { p_name: "calendar_ics_url" });
  if (!url) return { uid, skipped: "geen link" };
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
  try {
    const events = parseIcs(await fetchIcs(url), addDays(today, -1), addDays(today, 21), TZ).slice(0, 600);
    const n = await call<number>(db, "internal_save_calendar_busy", { p: { events } });
    return { uid, ok: true, events: n };
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    await call(db, "internal_save_calendar_busy", { p: { error: msg } }).catch(() => {});
    return { uid, error: msg };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST" }, 405);
  const cron = req.headers.get("x-cron-token");
  if (cron) {
    const expected = await call<string>(admin, "internal_get_secret", { p_name: "cron_token" });
    if (!expected || cron !== expected) return json({ error: "Geen toegang" }, 401);
    const users = await call<string[]>(admin, "internal_calendar_import_users");
    const out = [];
    for (const u of users) out.push(await runFor(u).catch((e) => ({ uid: u, error: String(e).slice(0, 200) })));
    console.log(JSON.stringify(out));
    return json({ results: out.length });
  }
  const jwt = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Niet ingelogd" }, 401);
  const { data: u } = await admin.auth.getUser(jwt);
  if (!u?.user || !(await call<boolean>(admin, "internal_is_owner", { p_uid: u.user.id }))) return json({ error: "Geen toegang" }, 403);
  const r: any = await runFor(u.user.id);
  return r.error ? json({ error: r.error }, 422) : json(r);
});
