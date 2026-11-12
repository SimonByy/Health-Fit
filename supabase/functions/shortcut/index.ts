// Endpoint voor iPhone-opdrachten (Opdrachten-app). Beveiligd met een geheime sleutel (?k=...), alleen de sha256 staat in app.settings.
// GET  ?a=briefing&k=...        -> platte tekst van de briefing van vandaag
// GET  ?a=log&q=kwark&k=...     -> logt 1 portie van een vast product en geeft een zin terug
// POST ?a=hevy&k=...  (body = Hevy CSV-export) -> importeert de trainingen van de laatste 120 dagen
import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const TZ = "Europe/Brussels";
// ---- Hevy CSV-parser (zelfde als in de app) ----
function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  mrt: 3, mei: 5, okt: 10 };
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(guess));
  const g = (k: string) => Number(parts.find((p) => p.type === k)!.value);
  const asTz = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"));
  return new Date(guess - (asTz - guess)).toISOString();
}
function parseHevyDate(s: string) {
  if (!s) return null;
  let m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})/);
  if (m && MONTHS[m[2].toLowerCase()]) return zonedToUtc(+m[3], MONTHS[m[2].toLowerCase()], +m[1], +m[4], +m[5]);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (m) return /Z|[+-]\d{2}:?\d{2}$/.test(s) ? new Date(s).toISOString() : zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5]);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function hash(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

function hevyCsvToWorkouts(text: string): any[] {
  const rows = parseCsv(text.replace(/^\uFEFF/, ""));
  if (rows.length < 2) throw new Error("Leeg bestand");
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => head.indexOf(name);
  const need = ["title", "start_time", "exercise_title"];
  for (const n of need) if (col(n) < 0) throw new Error(`Dit lijkt geen Hevy-export (kolom "${n}" ontbreekt)`);
  const v = (r: string[], name: string) => { const i = col(name); return i < 0 ? "" : (r[i] ?? "").trim(); };
  const n = (x: string) => (x === "" ? null : Number(String(x).replace(",", ".")));
  // deno-lint-ignore no-explicit-any
  const map = new Map<string, any>();
  for (const r of rows.slice(1)) {
    const key = `${v(r, "title")}|${v(r, "start_time")}`;
    const start = parseHevyDate(v(r, "start_time"));
    if (!start) continue;
    if (!map.has(key)) {
      map.set(key, { id: "csv-" + hash(key), title: v(r, "title"), description: v(r, "description"),
        start_time: start, end_time: parseHevyDate(v(r, "end_time")) || start, exercises: [], _ex: new Map() });
    }
    const w = map.get(key);
    const exKey = `${v(r, "exercise_title")}|${v(r, "superset_id")}`;
    if (!w._ex.has(exKey)) {
      const ex = { index: w.exercises.length, title: v(r, "exercise_title"), notes: v(r, "exercise_notes"),
        superset_id: v(r, "superset_id") || null, exercise_template_id: null, sets: [] as unknown[] };
      w._ex.set(exKey, ex);
      w.exercises.push(ex);
    }
    const ex = w._ex.get(exKey);
    let kg = n(v(r, "weight_kg"));
    if (kg === null && col("weight_lbs") >= 0) { const lb = n(v(r, "weight_lbs")); kg = lb === null ? null : lb * 0.45359237; }
    const km = n(v(r, "distance_km"));
    const mi = col("distance_miles") >= 0 ? n(v(r, "distance_miles")) : null;
    ex.sets.push({
      index: n(v(r, "set_index")) ?? ex.sets.length,
      type: v(r, "set_type") || "normal",
      weight_kg: kg, reps: n(v(r, "reps")),
      distance_meters: km !== null ? km * 1000 : mi !== null ? mi * 1609.344 : null,
      duration_seconds: n(v(r, "duration_seconds")), rpe: n(v(r, "rpe")),
    });
  }
  return [...map.values()].map(({ _ex, ...w }) => w);
}


const text = (t: string, s = 200) => new Response(t, { status: s, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const k = u.searchParams.get("k") || req.headers.get("x-key") || "";
  const { data: ok } = await admin.rpc("internal_shortcut_key_ok", { p_key: k });
  if (!ok) return text("Geen toegang", 401);
  const a = u.searchParams.get("a") || "briefing";
  try {
    if (a === "briefing") {
      const { data, error } = await admin.rpc("internal_briefing_text", {});
      if (error) throw error;
      return text(data || "Goeiemorgen Simon. Je briefing is nog niet klaar. Over een paar minuten krijg je een melding.");
    }
    if (a === "hevy") {
      // Body = het Hevy-exportbestand (rauw, of als formulier met één bestand)
      let csv = "";
      const ct = req.headers.get("content-type") || "";
      if (ct.includes("multipart/form-data")) {
        const fd = await req.formData();
        for (const [, val] of fd.entries()) { if (typeof val !== "string") { csv = await val.text(); break; } else if (val.includes("exercise_title")) { csv = val; break; } }
      } else {
        csv = await req.text();
        if (ct.includes("json")) { try { csv = JSON.parse(csv).csv || ""; } catch { /* rauwe tekst */ } }
      }
      if (!csv.trim()) return text("Geen bestand ontvangen. Deel de Hevy-export naar deze opdracht.", 400);
      const all = hevyCsvToWorkouts(csv);
      const since = new Date(Date.now() - 1000 * 60 * 60 * 24 * 120).toISOString();
      const recent = all.filter((w) => w.start_time >= since);
      for (let i = 0; i < recent.length; i += 40) {
        const { error } = await admin.rpc("internal_import_hevy", { p: recent.slice(i, i + 40) });
        if (error) throw error;
      }
      const last = recent.map((w) => w.start_time as string).sort().at(-1);
      return text(`${recent.length} Hevy-trainingen bijgewerkt in Health Hub${last ? ", laatste op " + new Date(last).toLocaleDateString("nl-BE", { timeZone: TZ, day: "numeric", month: "long" }) : ""}.`);
    }
    if (a === "log") {
      const q = (u.searchParams.get("q") || "").trim();
      if (!q) return text("Zeg welk product", 400);
      const meal = u.searchParams.get("meal") || null;
      const { data, error } = await admin.rpc("internal_log_quick", { p_query: q.slice(0, 60), p_meal: meal });
      if (error) throw error;
      return text(data?.message || "Gelogd", data?.ok ? 200 : 404);
    }
    return text("Onbekende actie", 400);
  } catch (e) {
    return text("Er ging iets mis: " + String((e as Error).message || e).slice(0, 200), 500);
  }
});
