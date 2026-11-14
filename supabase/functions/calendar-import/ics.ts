// Kleine iCalendar-lezer: VEVENT's (ook herhalende) binnen een venster, als UTC-tijden.
export type Busy = { day: string; start: string | null; end: string | null; all_day: boolean; title: string };

const WIN_TZ: Record<string, string> = {
  "Romance Standard Time": "Europe/Brussels", "W. Europe Standard Time": "Europe/Amsterdam", "GMT Standard Time": "Europe/London",
  "Central Europe Standard Time": "Europe/Budapest", "UTC": "UTC",
};
function zoneOf(tzid: string | undefined, fallback: string) {
  if (!tzid) return fallback;
  const z = WIN_TZ[tzid] ?? tzid.replace(/^\/.*?\//, "");
  try { new Intl.DateTimeFormat("en", { timeZone: z }); return z; } catch { return fallback; }
}
// UTC-ms van een lokale wandkloktijd in zone z
function wallToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, z: string) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const off = (t: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: z, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t;
  };
  let t = guess - off(guess);
  t = guess - off(t);
  return t;
}
const unesc = (s: string) => s.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();
type Prop = { v: string; p: Record<string, string> };
type DT = { y: number; mo: number; d: number; h: number; mi: number; s: number; utc: boolean; date: boolean; z: string };
function parseDT(pr: Prop | undefined, fb: string): DT | null {
  if (!pr) return null;
  const m = pr.v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/);
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: +(m[6] ?? 0), utc: !!m[7], date: pr.p.VALUE === "DATE" || !m[4], z: zoneOf(pr.p.TZID, fb) };
}
const toUtc = (t: DT) => t.utc ? Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi, t.s) : wallToUtc(t.y, t.mo, t.d, t.h, t.mi, t.s, t.z);
function durMs(v: string) {
  const m = v.match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  return (((+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 24 + +(m[4] ?? 0)) * 60 + +(m[5] ?? 0)) * 60000 + +(m[6] ?? 0) * 1000;
}
const iso = (y: number, mo: number, d: number) => `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const DAYMS = 86400000;
const BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
// lokale datum (in zone z) van een UTC-tijd
const localDay = (t: number, z: string) => new Date(t).toLocaleDateString("sv-SE", { timeZone: z });

export function parseIcs(text: string, from: string, to: string, fb = "Europe/Brussels"): Busy[] {
  const lines = text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
  const events: Record<string, Prop[]>[] = [];
  let cur: Record<string, Prop[]> | null = null, depth = 0;
  for (const ln of lines) {
    if (ln === "BEGIN:VEVENT") { cur = {}; depth = 0; continue; }
    if (!cur) continue;
    if (ln.startsWith("BEGIN:")) { depth++; continue; }      // VALARM e.d. overslaan
    if (ln.startsWith("END:") && depth) { depth--; continue; }
    if (ln === "END:VEVENT") { events.push(cur); cur = null; continue; }
    if (depth) continue;
    const i = ln.indexOf(":"); if (i < 0) continue;
    const [name, ...ps] = ln.slice(0, i).split(";");
    const p: Record<string, string> = {};
    for (const x of ps) { const j = x.indexOf("="); if (j > 0) p[x.slice(0, j).toUpperCase()] = x.slice(j + 1).replace(/^"|"$/g, ""); }
    (cur[name.toUpperCase()] ||= []).push({ v: ln.slice(i + 1), p });
  }
  const one = (e: Record<string, Prop[]>, k: string) => e[k]?.[0];
  const fromMs = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10)) - DAYMS;
  const toMs = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10)) + 2 * DAYMS;
  // vervangen exemplaren (RECURRENCE-ID): het origineel op die datum overslaan
  const overridden = new Set<string>();
  for (const e of events) { const r = parseDT(one(e, "RECURRENCE-ID"), fb); if (r) overridden.add(`${one(e, "UID")?.v}|${iso(r.y, r.mo, r.d)}`); }
  const out: Busy[] = [];
  const push = (startMs: number, endMs: number, allDay: boolean, title: string, z: string) => {
    if (endMs <= startMs) endMs = startMs + (allDay ? DAYMS : 30 * 60000);
    if (endMs < fromMs || startMs > toMs) return;
    if (allDay) {
      for (let t = startMs; t < endMs; t += DAYMS) {
        const day = new Date(t).toISOString().slice(0, 10);
        if (day >= from && day <= to) out.push({ day, start: null, end: null, all_day: true, title });
      }
      return;
    }
    const day = localDay(startMs, z);
    if (day >= from && day <= to) out.push({ day, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), all_day: false, title });
  };
  for (const e of events) {
    if (one(e, "STATUS")?.v.toUpperCase() === "CANCELLED") continue;
    if (one(e, "TRANSP")?.v.toUpperCase() === "TRANSPARENT") continue;   // als 'vrij' gemarkeerd
    const st = parseDT(one(e, "DTSTART"), fb); if (!st) continue;
    const en = parseDT(one(e, "DTEND"), fb);
    const title = unesc(one(e, "SUMMARY")?.v ?? "Bezet").slice(0, 120);
    const z = st.utc ? fb : st.z;
    const dur = en ? (st.date ? Date.UTC(en.y, en.mo - 1, en.d) - Date.UTC(st.y, st.mo - 1, st.d) : toUtc(en) - toUtc(st))
      : one(e, "DURATION") ? durMs(one(e, "DURATION")!.v) : st.date ? DAYMS : 0;
    const startOf = (y: number, mo: number, d: number) => st.date ? Date.UTC(y, mo - 1, d) : toUtc({ ...st, y, mo, d });
    const rr = one(e, "RRULE")?.v;
    if (!rr || one(e, "RECURRENCE-ID")) { push(startOf(st.y, st.mo, st.d), startOf(st.y, st.mo, st.d) + dur, st.date, title, z); continue; }
    const R: Record<string, string> = Object.fromEntries(rr.split(";").map((x) => x.split("=") as [string, string]));
    const freq = R.FREQ, interval = Math.max(1, +(R.INTERVAL ?? 1)), count = R.COUNT ? +R.COUNT : Infinity;
    const until = R.UNTIL ? parseDT({ v: R.UNTIL, p: {} }, fb) : null;
    const untilDay = until ? (until.utc && !st.date ? localDay(toUtc(until), z) : iso(until.y, until.mo, until.d)) : "9999-12-31";
    const ex = new Set<string>();
    for (const x of e["EXDATE"] ?? []) for (const v of x.v.split(",")) {
      const t = parseDT({ v, p: x.p }, fb); if (t) ex.add(t.utc && !t.date ? localDay(toUtc(t), z) : iso(t.y, t.mo, t.d));
    }
    const uid = one(e, "UID")?.v;
    const byday = (R.BYDAY ? R.BYDAY.split(",").map((x) => x.replace(/^[+-]?\d+/, "")) : null);
    const bymd = R.BYMONTHDAY ? R.BYMONTHDAY.split(",").map(Number) : null;
    const s0 = Date.UTC(st.y, st.mo - 1, st.d);
    const wk0 = s0 - ((new Date(s0).getUTCDay() + 6) % 7) * DAYMS;   // maandag van de startweek
    let n = 0;
    for (let t = s0; t <= toMs + DAYMS && n < count; t += DAYMS) {
      const dt = new Date(t), dIso = dt.toISOString().slice(0, 10);
      if (dIso > untilDay) break;
      const wd = BYDAY[dt.getUTCDay()];
      let hit = false;
      if (freq === "DAILY") hit = Math.round((t - s0) / DAYMS) % interval === 0 && (!byday || byday.includes(wd));
      else if (freq === "WEEKLY") hit = Math.floor((t - wk0) / (7 * DAYMS)) % interval === 0 && (byday ? byday.includes(wd) : dt.getUTCDay() === new Date(s0).getUTCDay());
      else if (freq === "MONTHLY") {
        const months = (dt.getUTCFullYear() - st.y) * 12 + dt.getUTCMonth() + 1 - st.mo;
        hit = months % interval === 0 && (bymd ? bymd.includes(dt.getUTCDate()) : dt.getUTCDate() === st.d);
      } else if (freq === "YEARLY") hit = (dt.getUTCFullYear() - st.y) % interval === 0 && dt.getUTCMonth() + 1 === st.mo && dt.getUTCDate() === st.d;
      if (!hit) continue;
      n++;
      if (ex.has(dIso) || overridden.has(`${uid}|${dIso}`)) continue;
      const s = startOf(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
      if (s + dur < fromMs) continue;
      push(s, s + dur, st.date, title, z);
    }
  }
  return out.sort((a, b) => (a.day + (a.start ?? "")).localeCompare(b.day + (b.start ?? "")));
}
