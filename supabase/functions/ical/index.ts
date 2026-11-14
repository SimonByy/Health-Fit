// Agenda-abonnement (iCal) voor Google Agenda, Apple/iCloud Agenda en Outlook.
// GET /functions/v1/ical?t=<geheime sleutel>. Alleen-lezen: geplande trainingen en de mealprep-zondag.
import { createClient } from "npm:@supabase/supabase-js@2";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(URL_, SR, { auth: { persistSession: false } });
const asUser = (uid: string) => createClient(URL_, SR, { auth: { persistSession: false }, global: { headers: { "x-hh-user": uid } } });
const TZ = "Europe/Brussels";

const esc = (s: unknown) => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
function fold(line: string) {
  const enc = new TextEncoder(); const out: string[] = []; let cur = "";
  for (const ch of line) {
    if (enc.encode(cur + ch).length > (out.length ? 74 : 75)) { out.push(cur); cur = ch; } else cur += ch;
  }
  out.push(cur);
  return out.join("\r\n ");
}
const d8 = (iso: string) => iso.slice(0, 10).replace(/-/g, "");
const t6 = (hhmm: string) => hhmm.slice(0, 8).replace(/:/g, "").padEnd(6, "0");
const nextDay = (iso: string) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
function addMin(hhmm: string, m: number) {
  const [h, mi] = hhmm.split(":").map(Number); const t = Math.min(23 * 60 + 59, h * 60 + mi + m);
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}:00`;
}
const VTZ = ["BEGIN:VTIMEZONE", "TZID:Europe/Brussels",
  "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "TZNAME:CEST", "DTSTART:19700329T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
  "BEGIN:STANDARD", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "TZNAME:CET", "DTSTART:19701025T030000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
  "END:VTIMEZONE"];

Deno.serve(async (req) => {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("GET", { status: 405 });
  const tok = new URL(req.url).searchParams.get("t") ?? "";
  if (!/^[0-9a-f]{64}$/.test(tok)) return new Response("Onbekende link", { status: 404 });
  const { data: uid } = await admin.rpc("internal_feed_user", { p_token: tok });
  if (!uid) return new Response("Deze agendalink werkt niet meer. Maak een nieuwe in Health Hub.", { status: 404 });
  const { data, error } = await asUser(uid).rpc("internal_agent_read", { q: `select
    (select jsonb_agg(jsonb_build_object('id', id, 'day', day, 'title', title, 'details', details, 'start', start_local, 'end', end_local,
        'dur', duration_min, 'status', status, 'upd', updated_at) order by day)
       from app.coach_sessions where day between current_date - 14 and current_date + 56 and coalesce(status, '') <> 'geschrapt'
         and coalesce(kind, '') <> 'rust') as sessies,
    (select jsonb_agg(jsonb_build_object('id', id, 'day', week_start, 'prep', prep, 'notes', notes))
       from app.mp_weeks where week_start between current_date - 14 and current_date + 56) as weken` });
  if (error) return new Response("Tijdelijk niet beschikbaar", { status: 503 });
  const row = Array.isArray(data) ? data[0] : data;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const L: string[] = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Health Hub//NL", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:Health Hub", "X-WR-TIMEZONE:Europe/Brussels", "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H", ...VTZ];
  for (const s of row?.sessies ?? []) {
    const title = (s.status === "gedaan" ? "✅ " : s.status === "overgeslagen" ? "🚫 " : "") + String(s.title || "Training").replace(/^(✅|🚫)\s*/u, "");
    L.push("BEGIN:VEVENT", `UID:hh-sessie-${s.id}@health-hub`, `DTSTAMP:${stamp}`, `SUMMARY:${esc(title)}`);
    if (s.start) {
      const end = s.end || addMin(s.start, Number(s.dur) || 60);
      L.push(`DTSTART;TZID=${TZ}:${d8(s.day)}T${t6(s.start)}`, `DTEND;TZID=${TZ}:${d8(s.day)}T${t6(end)}`);
    } else {
      L.push(`DTSTART;VALUE=DATE:${d8(s.day)}`, `DTEND;VALUE=DATE:${d8(nextDay(s.day))}`, "TRANSP:TRANSPARENT");
    }
    const desc = [s.details, s.dur && !s.start ? `± ${s.dur} min` : ""].filter(Boolean).join("\n");
    if (desc) L.push(`DESCRIPTION:${esc(desc)}`);
    L.push("END:VEVENT");
  }
  for (const w of row?.weken ?? []) {
    const prep = Array.isArray(w.prep) ? w.prep.join("\n") : "";
    L.push("BEGIN:VEVENT", `UID:hh-mealprep-${w.id}@health-hub`, `DTSTAMP:${stamp}`, "SUMMARY:Mealprep: boodschappen en koken",
      `DTSTART;VALUE=DATE:${d8(w.day)}`, `DTEND;VALUE=DATE:${d8(nextDay(w.day))}`, "TRANSP:TRANSPARENT",
      `DESCRIPTION:${esc((prep || "Kook alles voor de week; porties voor donderdag en vrijdag in de diepvries.") + "\n\nhttps://health-hub-simon.vercel.app/#/menu")}`, "END:VEVENT");
  }
  L.push("END:VCALENDAR");
  return new Response(L.map(fold).join("\r\n") + "\r\n", {
    headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "private, max-age=900", "Content-Disposition": 'inline; filename="health-hub.ics"' },
  });
});
